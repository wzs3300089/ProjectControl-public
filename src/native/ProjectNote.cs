using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Threading;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        string data = Path.GetFullPath(Option(args, "--data", Path.Combine(root, "data", "note.sqlite")));
        string node = Option(args, "--node", "node.exe");
        string identity;
        using (var hash = SHA256.Create())
            identity = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(data.ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
        string name = "Local\\ProjectControl.Note." + identity;
        bool created;
        using (var mutex = new Mutex(true, name, out created))
        using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Show"))
        using (var exit = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Exit"))
        {
            if (!created || args.Contains("--exit"))
            {
                if (args.Contains("--exit")) exit.Set();
                else show.Set();
                return 0;
            }
            try
            {
                var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                var desktop = new DesktopNote(app, node, root, data, show, exit);
                app.Startup += delegate { desktop.Start(); };
                app.Exit += delegate { desktop.Stop(); };
                app.Run();
                return 0;
            }
            catch (Exception error)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(data));
                File.AppendAllText(Path.Combine(Path.GetDirectoryName(data), "native-error.log"), DateTime.UtcNow.ToString("O") + " " + error + Environment.NewLine);
                MessageBox.Show(error.Message, "项目便签启动失败");
                return 1;
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private static string Option(string[] args, string key, string fallback)
    {
        int index = Array.IndexOf(args, key);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : fallback;
    }
}

internal sealed class DesktopNote
{
    private readonly Application app;
    private readonly string node, root, data;
    private readonly EventWaitHandle showSignal, exitSignal;
    private readonly DispatcherTimer timer = new DispatcherTimer();
    private Window editor;
    private TextBox note;
    private ComboBox status;
    private TextBlock feedback;
    private Button save, reload;
    private IntPtr codex;
    private bool busy, dirty, applying, stopping;
    private long revision;

    public DesktopNote(Application app, string node, string root, string data, EventWaitHandle show, EventWaitHandle exit)
    {
        this.app = app; this.node = node; this.root = root; this.data = data;
        showSignal = show; exitSignal = exit;
    }

    public void Start()
    {
        codex = FindCodex();
        timer.Interval = TimeSpan.FromMilliseconds(400);
        timer.Tick += async delegate {
            if (exitSignal.WaitOne(0)) { stopping = true; app.Shutdown(); return; }
            if (showSignal.WaitOne(0)) await ShowEditor();
        };
        timer.Start();
        app.Dispatcher.BeginInvoke(new Action(async delegate { await ShowEditor(); }));
    }

    private void CreateEditor()
    {
        editor = (Window)XamlReader.Parse(@"
<Window xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'
 xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' Title='项目便签 · 独立浮窗'
 Width='520' Height='440' MinWidth='380' MinHeight='340' Topmost='True' ShowInTaskbar='True'
 Background='#FAFBFD' FontFamily='Microsoft YaHei UI' FontSize='14'>
 <Grid Margin='24'>
  <Grid.RowDefinitions><RowDefinition Height='Auto'/><RowDefinition Height='Auto'/><RowDefinition Height='*'/><RowDefinition Height='Auto'/><RowDefinition Height='Auto'/></Grid.RowDefinitions>
  <TextBlock Text='项目便签' FontSize='21' FontWeight='SemiBold'/>
  <TextBlock Grid.Row='1' Text='内容' Margin='0,18,0,8'/>
  <TextBox x:Name='Note' Grid.Row='2' AcceptsReturn='True' AcceptsTab='True' TextWrapping='Wrap'
   MaxLength='100000' VerticalScrollBarVisibility='Auto' Padding='12' BorderBrush='#CCD1DA' Background='White'/>
  <StackPanel Grid.Row='3' Orientation='Horizontal' Margin='0,18,0,0'>
   <TextBlock Text='状态' VerticalAlignment='Center' Margin='0,0,14,0'/>
   <ComboBox x:Name='Status' Width='130' Padding='8,5' SelectedIndex='0'>
    <ComboBoxItem Content='待完成' Tag='pending'/><ComboBoxItem Content='完成' Tag='completed'/>
   </ComboBox>
  </StackPanel>
  <Grid Grid.Row='4' Margin='0,22,0,0'>
   <Grid.ColumnDefinitions><ColumnDefinition Width='*'/><ColumnDefinition Width='Auto'/><ColumnDefinition Width='Auto'/></Grid.ColumnDefinitions>
   <TextBlock x:Name='Feedback' VerticalAlignment='Center' TextWrapping='Wrap' FontSize='12' Foreground='#687080' Margin='0,0,10,0'/>
   <Button x:Name='Reload' Grid.Column='1' Content='重新读取' Padding='10,7' Margin='0,0,8,0'/>
   <Button x:Name='Save' Grid.Column='2' Content='保存' Padding='20,7' Background='#283A70' Foreground='White' BorderBrush='#283A70'/>
  </Grid>
 </Grid>
</Window>");
        note = (TextBox)editor.FindName("Note"); status = (ComboBox)editor.FindName("Status");
        feedback = (TextBlock)editor.FindName("Feedback"); save = (Button)editor.FindName("Save");
        reload = (Button)editor.FindName("Reload");
        note.TextChanged += delegate { Changed(); };
        status.SelectionChanged += delegate { Changed(); };
        save.Click += async delegate { await Save(); };
        reload.Click += async delegate {
            if (dirty && MessageBox.Show(editor, "重新读取会替换尚未保存的内容，是否继续？", "重新读取", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
            await Load();
        };
        editor.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) {
            if (stopping) return;
            if (busy) { e.Cancel = true; return; }
            if (dirty && MessageBox.Show(editor, "内容尚未保存，是否放弃修改并关闭？", "关闭便签", MessageBoxButton.YesNo) != MessageBoxResult.Yes) e.Cancel = true;
        };
        editor.Closed += delegate { if (!stopping) app.Shutdown(); };
        if (codex != IntPtr.Zero) new WindowInteropHelper(editor).Owner = codex;
        editor.WindowStartupLocation = WindowStartupLocation.CenterScreen;
    }

    private async Task ShowEditor()
    {
        if (editor == null) CreateEditor();
        bool wasVisible = editor.IsVisible;
        editor.Show();
        if (editor.WindowState == WindowState.Minimized) editor.WindowState = WindowState.Normal;
        editor.Activate();
        if (!wasVisible && !dirty && !busy) await Load();
        note.Focus();
    }

    private void Changed()
    {
        if (applying) return;
        dirty = true; Message("有未保存的修改", false);
    }

    private void Message(string text, bool error)
    {
        feedback.Text = text;
        feedback.Foreground = error ? Brushes.Firebrick : new SolidColorBrush(Color.FromRgb(104, 112, 128));
    }

    private void SetBusy(bool value)
    {
        busy = value;
        note.IsEnabled = status.IsEnabled = save.IsEnabled = reload.IsEnabled = !value;
    }

    private void Apply(Dictionary<string, object> value)
    {
        applying = true;
        try {
            revision = Convert.ToInt64(value["revision"]);
            note.Text = (string)value["text"];
            status.SelectedIndex = (string)value["status"] == "completed" ? 1 : 0;
            dirty = false;
        } finally { applying = false; }
    }

    private async Task Load()
    {
        SetBusy(true); Message("正在读取…", false);
        bool loaded = false;
        try {
            Apply(await Task.Run(() => Call(new { action = "read" })));
            loaded = true; Message("已读取保存的内容", false);
        } catch (Exception error) { Message("读取失败：" + error.Message, true); }
        finally { SetBusy(false); if (!loaded) { note.IsEnabled = status.IsEnabled = save.IsEnabled = false; } }
    }

    private async Task Save()
    {
        if (busy) return;
        var request = new { action = "save", value = new {
            text = note.Text, status = (string)((ComboBoxItem)status.SelectedItem).Tag, revision = revision
        }};
        SetBusy(true); Message("正在保存…", false);
        try { Apply(await Task.Run(() => Call(request))); Message("已保存", false); }
        catch (Exception error) { Message("保存失败：" + error.Message, true); }
        finally { SetBusy(false); }
    }

    private Dictionary<string, object> Call(object request)
    {
        var json = new JavaScriptSerializer { MaxJsonLength = 1000000 };
        var info = new ProcessStartInfo(node, Quote(Path.Combine(root, "src", "native-bridge.mjs")) + " --data " + Quote(data)) {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        using (var process = Process.Start(info)) {
            var output = process.StandardOutput.ReadToEndAsync();
            var errors = process.StandardError.ReadToEndAsync();
            byte[] payload = new UTF8Encoding(false).GetBytes(json.Serialize(request));
            process.StandardInput.BaseStream.Write(payload, 0, payload.Length);
            process.StandardInput.Close();
            if (!process.WaitForExit(10000)) { process.Kill(); throw new TimeoutException("存储操作超时，请重试。"); }
            string text = output.GetAwaiter().GetResult();
            if (String.IsNullOrWhiteSpace(text)) throw new IOException("存储进程异常退出（" + process.ExitCode + "）：" + errors.GetAwaiter().GetResult());
            var result = json.Deserialize<Dictionary<string, object>>(text);
            if (!(bool)result["ok"]) throw new IOException((string)result["error"]);
            return (Dictionary<string, object>)result["value"];
        }
    }

    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }

    private static IntPtr FindCodex()
    {
        foreach (var process in Process.GetProcessesByName("ChatGPT")) {
            using (process) {
                try {
                    var handle = process.MainWindowHandle;
                    if (handle != IntPtr.Zero && process.MainModule.FileName.IndexOf("OpenAI.Codex", StringComparison.OrdinalIgnoreCase) >= 0)
                        return handle;
                } catch (System.ComponentModel.Win32Exception) { /* The window is being closed or is inaccessible. */ }
                catch (InvalidOperationException) { /* The process exited during enumeration. */ }
            }
        }
        return IntPtr.Zero;
    }

    public void Stop()
    {
        stopping = true; timer.Stop();
        if (editor != null && editor.IsVisible) editor.Close();
    }
}
