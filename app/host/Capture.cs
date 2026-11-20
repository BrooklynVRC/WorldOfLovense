// Capture mode (WoW-LovenseLink.exe --capture): grabs frames of one window through Windows Graphics Capture.
// READ-ONLY: this asks Windows (DWM) for the window's picture, the same way OBS window capture
// and Discord screen share do. It never opens, injects into, or sends input/messages to the game.
// Works while the window is covered or unfocused; a minimized window can't be captured.
//
// Protocol (stdin/stdout, one line each):
//   "cap <width> [zx zy zw zh]"  ->  "OK <base64 BMP of the game area at <width>> [<base64 BMP of the zoom area at full resolution>]"
//                                |  "ERR <message>"
// The optional zoom area (0..1 fractions of the game area) is returned at native resolution, so small text like
// the addon signal strip stays sharp.
using System.Diagnostics;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Foundation.Metadata;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

[ComImport, System.Runtime.InteropServices.Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
interface IGraphicsCaptureItemInterop
{
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
}

[ComImport, System.Runtime.InteropServices.Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
interface IDirect3DDxgiInterfaceAccess
{
    IntPtr GetInterface([In] ref Guid iid);
}

static class Native
{
    [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice", ExactSpelling = true)]
    public static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}

static class CaptureMode
{
    static readonly Guid IID_IGraphicsCaptureItem = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    static readonly Guid IID_ID3D11Texture2D = new("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

    static readonly object Gate = new();
    static string processName = "Wow";
    static ID3D11Device d3d = null!;
    static ID3D11DeviceContext ctx = null!;
    static IDirect3DDevice device = null!;

    static IntPtr hwnd;
    static GraphicsCaptureItem? item;
    static Direct3D11CaptureFramePool? pool;
    static GraphicsCaptureSession? session;
    static Windows.Graphics.SizeInt32 poolSize;
    static ID3D11Texture2D? staging;      // holds the most recent frame
    static int contentW, contentH;
    static bool keepAspect = true;   // crop to the 16:9 game area (removes letterbox/pillarbox)

    public static int Run(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--process") processName = args[i + 1];
        if (args.Contains("--no-aspect")) keepAspect = false;
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // per-monitor v2: real pixel coordinates
        try { InitDevice(); }
        catch (Exception e) { Console.WriteLine("ERR could not start Direct3D: " + e.Message); return 1; }

        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            var parts = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) continue;
            if (parts[0] == "quit") break;
            if (parts[0] != "cap") { Console.WriteLine("ERR unknown command"); continue; }
            int width = parts.Length > 1 && int.TryParse(parts[1], out var w) ? Math.Clamp(w, 64, 3840) : 480;
            double[]? zone = null;
            if (parts.Length >= 6)
            {
                var z = parts.Skip(2).Take(4).Select(p => double.TryParse(p, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : double.NaN).ToArray();
                if (z.All(v => !double.IsNaN(v)) && z[2] > 0.01 && z[3] > 0.01) zone = z;
            }
            try { var (main, zoom) = Capture(width, zone); Console.WriteLine("OK " + Convert.ToBase64String(main) + (zoom != null ? " " + Convert.ToBase64String(zoom) : "")); }
            catch (Exception e) { Console.WriteLine("ERR " + e.Message.Replace('\r', ' ').Replace('\n', ' ')); }
            Console.Out.Flush();
        }
        StopSession();
        return 0;
    }

    static void InitDevice()
    {
        D3D11.D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport, null, out d3d!, out ctx!).CheckError();
        using var dxgi = d3d.QueryInterface<IDXGIDevice>();
        Marshal.ThrowExceptionForHR(Native.CreateDirect3D11DeviceFromDXGIDevice(dxgi.NativePointer, out var p));
        device = MarshalInterface<IDirect3DDevice>.FromAbi(p);
        Marshal.Release(p);
    }

    static IntPtr FindGameWindow()
    {
        foreach (var p in Process.GetProcessesByName(processName))
        {
            try { if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle; } catch { }
        }
        return IntPtr.Zero;
    }

    static void StartSession(IntPtr window)
    {
        StopSession();
        var interop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
        var iid = IID_IGraphicsCaptureItem;
        var ptr = interop.CreateForWindow(window, ref iid);
        item = GraphicsCaptureItem.FromAbi(ptr);
        Marshal.Release(ptr);
        item.Closed += (_, _) => { lock (Gate) StopSession(); };

        poolSize = item.Size;
        pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, poolSize);
        session = pool.CreateCaptureSession(item);
        try { if (ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "IsCursorCaptureEnabled")) session.IsCursorCaptureEnabled = false; } catch { }
        try { if (ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "IsBorderRequired")) session.IsBorderRequired = false; } catch { }
        session.StartCapture();
        hwnd = window;
    }

    static void StopSession()
    {
        try { session?.Dispose(); } catch { }
        try { pool?.Dispose(); } catch { }
        session = null; pool = null; item = null; hwnd = IntPtr.Zero;
        staging?.Dispose(); staging = null; contentW = contentH = 0;
    }

    static (byte[] main, byte[]? zoom) Capture(int outW, double[]? zone)
    {
        lock (Gate)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd))
            {
                var w = FindGameWindow();
                if (w == IntPtr.Zero) throw new Exception("game window not found (is WoW running?)");
                StartSession(w);
            }
            if (Native.IsIconic(hwnd)) throw new Exception("game window is minimized (it can be behind other windows, but not minimized)");

            // Drain to the newest frame, copy it into our staging texture.
            Direct3D11CaptureFrame? frame = null, next;
            while ((next = pool!.TryGetNextFrame()) != null) { frame?.Dispose(); frame = next; }
            if (frame != null)
            {
                using (frame)
                {
                    var size = frame.ContentSize;
                    var access = frame.Surface.As<IDirect3DDxgiInterfaceAccess>();
                    var iid = IID_ID3D11Texture2D;
                    using var src = new ID3D11Texture2D(access.GetInterface(ref iid));
                    var desc = src.Description;
                    if (staging == null || staging.Description.Width != desc.Width || staging.Description.Height != desc.Height)
                    {
                        staging?.Dispose();
                        desc.Usage = ResourceUsage.Staging; desc.BindFlags = BindFlags.None;
                        desc.CPUAccessFlags = CpuAccessFlags.Read; desc.MiscFlags = ResourceOptionFlags.None;
                        staging = d3d.CreateTexture2D(desc);
                    }
                    ctx.CopyResource(staging, src);
                    contentW = (int)Math.Min(size.Width, desc.Width);
                    contentH = (int)Math.Min(size.Height, desc.Height);
                    if (size.Width != poolSize.Width || size.Height != poolSize.Height)
                    {
                        poolSize = size; // window was resized
                        pool.Recreate(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
                    }
                }
            }
            if (staging == null || contentW <= 0 || contentH <= 0) throw new Exception("waiting for the first frame");
            var (cx, cy, cw, ch) = GameArea();
            var main = ToBmp(outW, cx, cy, cw, ch);
            byte[]? zoom = null;
            if (zone != null)
            {
                int zx = cx + (int)Math.Round(Math.Clamp(zone[0], 0, 1) * cw), zy = cy + (int)Math.Round(Math.Clamp(zone[1], 0, 1) * ch);
                int zw = Math.Min((int)Math.Round(zone[2] * cw), cx + cw - zx), zh = Math.Min((int)Math.Round(zone[3] * ch), cy + ch - zy);
                if (zw > 8 && zh > 8) zoom = ToBmp(Math.Min(zw, 1600), zx, zy, zw, zh);
            }
            return (main, zoom);
        }
    }

    // The part of the captured frame that is the game: the client area (no title bar or borders),
    // then the centred 16:9 area. This makes windowed, borderless and fullscreen look the same.
    static (int x, int y, int w, int h) GameArea()
    {
        int x = 0, y = 0, w = contentW, h = contentH;
        try
        {
            if (Native.DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out var fr, Marshal.SizeOf<Native.RECT>()) == 0
                && Native.GetClientRect(hwnd, out var cr))
            {
                var pt = new Native.POINT();
                Native.ClientToScreen(hwnd, ref pt);
                double sx = contentW / (double)Math.Max(1, fr.Right - fr.Left), sy = contentH / (double)Math.Max(1, fr.Bottom - fr.Top);
                int cx = (int)Math.Round((pt.X - fr.Left) * sx), cy = (int)Math.Round((pt.Y - fr.Top) * sy);
                int cw = (int)Math.Round(cr.Right * sx), ch = (int)Math.Round(cr.Bottom * sy);
                if (cw > 16 && ch > 16) { x = Math.Clamp(cx, 0, contentW - 1); y = Math.Clamp(cy, 0, contentH - 1); w = Math.Min(cw, contentW - x); h = Math.Min(ch, contentH - y); }
            }
        }
        catch { }
        if (keepAspect && w > 16 && h > 16)
        {
            double a = w / (double)h, target = 16.0 / 9.0;
            if (a > target * 1.01) { int nw = (int)Math.Round(h * target); x += (w - nw) / 2; w = nw; }
            else if (a < target / 1.01) { int nh = (int)Math.Round(w / target); y += (h - nh) / 2; h = nh; }
        }
        return (x, y, w, h);
    }

    // Box-filter downscale of the game area into a 24-bit bottom-up BMP.
    static unsafe byte[] ToBmp(int outW, int cx, int cy, int cw, int ch)
    {
        outW = Math.Min(outW, cw);
        int outH = Math.Max(1, (int)Math.Round(ch * (double)outW / cw));
        int stride = (outW * 3 + 3) & ~3;
        var bmp = new byte[54 + stride * outH];
        WriteHeader(bmp, outW, outH, stride);

        var map = ctx.Map(staging!, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
        try
        {
            byte* basePtr = (byte*)map.DataPointer;
            int pitch = (int)map.RowPitch;
            for (int oy = 0; oy < outH; oy++)
            {
                int y0 = cy + oy * ch / outH, y1 = Math.Max(y0 + 1, cy + (oy + 1) * ch / outH);
                int dst = 54 + (outH - 1 - oy) * stride;
                for (int ox = 0; ox < outW; ox++)
                {
                    int x0 = cx + ox * cw / outW, x1 = Math.Max(x0 + 1, cx + (ox + 1) * cw / outW);
                    int sb = 0, sg = 0, sr = 0, n = 0;
                    for (int y = y0; y < y1; y += Math.Max(1, (y1 - y0) / 3))
                    {
                        byte* row = basePtr + y * pitch;
                        for (int x = x0; x < x1; x += Math.Max(1, (x1 - x0) / 3))
                        {
                            byte* px = row + x * 4; sb += px[0]; sg += px[1]; sr += px[2]; n++;
                        }
                    }
                    bmp[dst + ox * 3] = (byte)(sb / n); bmp[dst + ox * 3 + 1] = (byte)(sg / n); bmp[dst + ox * 3 + 2] = (byte)(sr / n);
                }
            }
        }
        finally { ctx.Unmap(staging!, 0); }
        return bmp;
    }

    static void WriteHeader(byte[] b, int w, int h, int stride)
    {
        b[0] = (byte)'B'; b[1] = (byte)'M';
        BitConverter.GetBytes(b.Length).CopyTo(b, 2);
        BitConverter.GetBytes(54).CopyTo(b, 10);
        BitConverter.GetBytes(40).CopyTo(b, 14);
        BitConverter.GetBytes(w).CopyTo(b, 18);
        BitConverter.GetBytes(h).CopyTo(b, 22);
        BitConverter.GetBytes((short)1).CopyTo(b, 26);
        BitConverter.GetBytes((short)24).CopyTo(b, 28);
        BitConverter.GetBytes(stride * h).CopyTo(b, 34);
    }
}
