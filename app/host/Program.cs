using System.Reflection;
using System.Text.Json;

namespace LovenseLinkHost;

public sealed class AppInfo
{
    public string Title { get; set; } = "WoW LovenseLink";
    public string DataFolder { get; set; } = "WoWLovenseLink";
    public string Accent { get; set; } = "#3fb6a8";
    public string Letter { get; set; } = "M";
}

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Contains("--capture")) return CaptureMode.Run(args);

        var info = LoadInfo();
        string? attach = null;
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--url") attach = args[i + 1];   // dev: show an already-running server
            if (args[i] == "--title") info.Title = args[i + 1];
        }
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(info, attach));
        return 0;
    }

    static AppInfo LoadInfo()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("appinfo.json");
        if (s == null) return new AppInfo();
        return JsonSerializer.Deserialize<AppInfo>(s, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new AppInfo();
    }
}
