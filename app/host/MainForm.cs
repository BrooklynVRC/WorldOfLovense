// The app window: starts the bundled server hidden, then shows its pages in WebView2 (the Edge engine built into Windows).
using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LovenseLinkHost;

sealed class MainForm : Form
{
    readonly AppInfo info;
    readonly string? attachUrl;
    readonly WebView2 web = new() { Dock = DockStyle.Fill, Visible = false };
    readonly Label status = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 12f), ForeColor = Color.Gainsboro, BackColor = Color.FromArgb(17, 19, 25) };
    readonly string dataDir, logPath;
    readonly StreamWriter log;
    readonly Queue<string> lastLines = new();
    Process? server;
    string? url;
    bool weStarted, webviewFailed, closing;

    public MainForm(AppInfo info, string? attachUrl)
    {
        this.info = info;
        this.attachUrl = attachUrl;
        Text = info.Title;
        ClientSize = new Size(1280, 880);
        MinimumSize = new Size(720, 520);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(17, 19, 25);
        Icon = MakeIcon(info);
        Controls.Add(web);
        Controls.Add(status);
        status.Text = $"Starting {info.Title}…";

        dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), info.DataFolder);
        Directory.CreateDirectory(dataDir);
        logPath = Path.Combine(dataDir, "app.log");
        log = new StreamWriter(logPath, append: false) { AutoFlush = true };

        Load += async (_, _) => await StartAsync();
        FormClosing += OnClosing;
    }

    async Task StartAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDir, "webview"));
            await web.EnsureCoreWebView2Async(env);
            var s = web.CoreWebView2.Settings;
            s.IsStatusBarEnabled = false;
            s.AreDevToolsEnabled = false;
            s.IsZoomControlEnabled = true;
            // Links meant for a new tab (e.g. the OBS overlay, docs) open in the normal browser.
            web.CoreWebView2.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        }
        catch (Exception ex)
        {
            webviewFailed = true;
            Log("WebView2 unavailable: " + ex.Message);
            status.Text = "Microsoft Edge WebView2 isn't installed, so the app will open in your browser.\nKeep this window open while you use it.";
        }
        if (attachUrl != null) { Navigate(attachUrl); return; }
        StartServer();
    }

    void StartServer()
    {
        var exe = ExtractServer();
        if (exe == null) { status.Text = "This build has no app inside (developer build). Start it with --url."; return; }
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = dataDir,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8, StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        psi.Environment["MSB_HOSTED"] = "1";
        psi.Environment["MSB_HOST_EXE"] = Environment.ProcessPath!;
        server = new Process { StartInfo = psi, EnableRaisingEvents = true };
        server.OutputDataReceived += (_, e) => OnLine(e.Data);
        server.ErrorDataReceived += (_, e) => OnLine(e.Data);
        server.Exited += (_, _) => BeginInvoke(() =>
        {
            if (closing || !weStarted) return;
            web.Visible = false; status.Visible = true;
            status.Text = $"{info.Title} stopped unexpectedly.\n\nLog: {logPath}\n\n" + string.Join("\n", lastLines);
        });
        server.Start();
        weStarted = true;
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
    }

    void OnLine(string? line)
    {
        if (line == null) return;
        Log(line);
        lock (lastLines) { lastLines.Enqueue(line); while (lastLines.Count > 12) lastLines.Dequeue(); }
        bool ready = line.StartsWith("MSB_READY "), already = line.StartsWith("MSB_ALREADY ");
        if (!ready && !already) return;
        if (already) weStarted = false; // another copy is already running; just show it
        var u = line[(line.IndexOf(' ') + 1)..].Trim();
        BeginInvoke(() => Navigate(u));
    }

    void Navigate(string u)
    {
        url = u.EndsWith('/') ? u : u + "/";
        if (webviewFailed) { OpenExternal(url); return; }
        web.CoreWebView2.Navigate(url);
        web.Visible = true;
        status.Visible = false;
    }

    string? ExtractServer()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("server.exe");
        if (s == null) return null;
        var bytes = new byte[s.Length];
        s.ReadExactly(bytes);
        var hash = Convert.ToHexString(SHA256.HashData(bytes))[..12].ToLowerInvariant();
        var bin = Path.Combine(dataDir, "bin");
        Directory.CreateDirectory(bin);
        var path = Path.Combine(bin, $"server-{hash}.exe");
        if (!File.Exists(path)) File.WriteAllBytes(path, bytes);
        foreach (var old in Directory.GetFiles(bin, "server-*.exe"))
            if (!old.Equals(path, StringComparison.OrdinalIgnoreCase)) try { File.Delete(old); } catch { }
        return path;
    }

    async void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (closing || server == null || server.HasExited || !weStarted) { closing = true; return; }
        e.Cancel = true;
        closing = true;
        web.Visible = false; status.Visible = true; status.Text = "Closing…";
        try
        {
            // Lets the app shut down cleanly (the Lovense app stops the toy first).
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            await http.PostAsync((url ?? "http://localhost/") + "api/shutdown", null);
        }
        catch { }
        await Task.Run(() => server.WaitForExit(4000));
        if (!server.HasExited) try { server.Kill(true); } catch { }
        Close();
    }

    void Log(string line) { try { lock (log) log.WriteLine(line); } catch { } }

    static void OpenExternal(string u)
    {
        try { Process.Start(new ProcessStartInfo(u) { UseShellExecute = true }); } catch { }
    }

    static Icon MakeIcon(AppInfo info)
    {
        var bmp = new Bitmap(64, 64);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            Color accent;
            try { accent = ColorTranslator.FromHtml(info.Accent); } catch { accent = Color.Teal; }
            using var path = new GraphicsPath();
            path.AddArc(2, 2, 20, 20, 180, 90); path.AddArc(42, 2, 20, 20, 270, 90);
            path.AddArc(42, 42, 20, 20, 0, 90); path.AddArc(2, 42, 20, 20, 90, 90); path.CloseFigure();
            using (var b = new SolidBrush(accent)) g.FillPath(b, path);
            using var f = new Font("Segoe UI", 30f, FontStyle.Bold, GraphicsUnit.Pixel);
            var sz = g.MeasureString(info.Letter, f);
            g.DrawString(info.Letter, f, Brushes.White, (64 - sz.Width) / 2, (64 - sz.Height) / 2);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }
}
