using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// One-version, one-file installer. No directory ACL changes or application integrity bypasses.
internal static class ClientPatchInstaller
{
    const string Target = @"C:\Program Files\WindowsApps\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0\app\resources\app.asar";
    const string ClientExe = @"C:\Program Files\WindowsApps\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe";
    const string OriginalHash = "99ed83950473e34e642f2942226bf40ce9b65e9910afbe8e406120459823c02d";
    const string PatchedHash = "a2b01c255d45829ef6708bfd0d997c03f95f2927372034734761ef7ee6b1f202";
    const string OriginalTrust = "S:AI(TL;ID;0x1f01a9;;;S-1-19-512-4096)";
    static readonly string Root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
    static readonly string Prepared = Path.Combine(Root, "patches", "prepared");
    static readonly string Candidate = Path.Combine(Prepared, "app.sidebar-popup.asar");
    static readonly string Backup = Path.Combine(Root, "patches", "rollback", "app.original.asar");
    static readonly string SecurityFile = Path.Combine(Root, "patches", "rollback", "security.json");
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1) throw new ArgumentException("Use --check, --apply, or --restore.");
            if (args[0] == "--check")
            {
                ValidateInputs(false);
                Log("CHECK_OK: exact source and candidate hashes match.");
                return 0;
            }
            if (args[0] == "--apply" || args[0] == "--restore")
                return Supervise(args[0] == "--restore", false);
            // These opt-in modes require separate, explicit approval for the temporary file trust change.
            if (args[0] == "--apply-with-temporary-file-trust" || args[0] == "--restore-with-temporary-file-trust")
                return Supervise(args[0].StartsWith("--restore"), true);
            if (args[0] == "--elevated-apply" || args[0] == "--elevated-restore")
                return Apply(args[0] == "--elevated-restore", false);
            if (args[0] == "--elevated-apply-with-temporary-file-trust" || args[0] == "--elevated-restore-with-temporary-file-trust")
                return Apply(args[0].StartsWith("--elevated-restore"), true);
            throw new ArgumentException("Unknown operation.");
        }
        catch (Exception error)
        {
            Log("FAILED: " + error);
            WriteJson("installer-error.json", new { error = error.ToString(), nativeErrorCode =
                error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0, time = DateTime.UtcNow.ToString("o") });
            return 1;
        }
    }

    static int Supervise(bool restore, bool temporarilyRelaxTrust)
    {
        bool acquired;
        using (var guard = new Mutex(true, @"Local\ProjectControl.ClientPatchInstaller", out acquired))
        {
            if (!acquired) throw new InvalidOperationException("An installer is already running.");
            Log(restore ? "REQUESTING_UAC_RESTORE" : "REQUESTING_UAC_APPLY");
            var info = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
                (restore ? "--elevated-restore" : "--elevated-apply") +
                    (temporarilyRelaxTrust ? "-with-temporary-file-trust" : "")) {
                UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Root
            };
            int code;
            using (var worker = Process.Start(info)) { worker.WaitForExit(); code = worker.ExitCode; }
            Log("WORKER_EXIT: " + code);
            // Launch from this unelevated supervisor, even if the worker rolled back.
            // A failed preflight never closes Codex, so it needs no relaunch.
            if (!ClientProcesses().Any())
            {
                Process.Start(new ProcessStartInfo("explorer.exe", @"shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App") {
                    UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden
                });
                Log("CLIENT_RELAUNCH_REQUESTED");
                WriteJson("restart.json", new { restartRequested = true, workerExitCode = code, uiVerified = false,
                    time = DateTime.UtcNow.ToString("o") });
            }
            return code;
        }
    }

    static int Apply(bool restore, bool temporarilyRelaxTrust)
    {
        var principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
        if (!principal.IsInRole(WindowsBuiltInRole.Administrator))
            throw new UnauthorizedAccessException("An elevated Windows administrator token is required.");
        ValidateInputs(restore);
        EnablePrivilege("SeBackupPrivilege");
        EnablePrivilege("SeRestorePrivilege");
        // Test authorization without writing. An existing reader may deny write sharing until exit.
        int openError;
        using (var handle = OpenTarget(7, out openError))
        {
            if (handle.IsInvalid)
            {
                Log("WRITE_PREFLIGHT_NATIVE_ERROR: " + openError);
                if (openError != 32 && openError != 33 && !(openError == 5 && temporarilyRelaxTrust))
                    throw new Win32Exception(openError, "Target write preflight failed (" + openError + ")");
            }
        }
        if (ReadTrust() != OriginalTrust) throw new IOException("Unexpected process trust label; refusing to proceed.");
        string security = File.GetAccessControl(Target, AccessControlSections.Owner | AccessControlSections.Group |
            AccessControlSections.Access).GetSecurityDescriptorSddlForm(AccessControlSections.Owner |
                AccessControlSections.Group | AccessControlSections.Access);
        if (!restore)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Backup));
            if (!File.Exists(Backup))
            {
                using (var source = File.OpenRead(Target))
                using (var backup = new FileStream(Backup, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                { source.CopyTo(backup); backup.Flush(true); }
            }
            RequireHash(Backup, OriginalHash);
            if (!File.Exists(SecurityFile))
                File.WriteAllText(SecurityFile, Json.Serialize(new { target = Target, sddl = security,
                    processTrust = OriginalTrust, originalHash = OriginalHash }), new UTF8Encoding(false));
        }
        Log("VALIDATED_AND_BACKED_UP: " + (restore ? "restore" : "apply"));
        var saved = Json.DeserializeObject(File.ReadAllText(SecurityFile)) as System.Collections.Generic.Dictionary<string, object>;
        if (saved == null || (string)saved["sddl"] != security)
            throw new InvalidOperationException("Target security differs from the saved original; refusing to proceed.");
        // Lock the verified input against concurrent modification for the whole replacement.
        using (var input = File.Open(restore ? Backup : Candidate, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            RequireHash(input, restore ? OriginalHash : PatchedHash);
            StopClient();
            bool writeStarted = false;
            try
            {
                using (var handle = OpenWritableTarget(temporarilyRelaxTrust))
                {
                    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open exact target exclusively");
                    using (var output = new FileStream(handle, FileAccess.ReadWrite))
                    {
                        RequireHash(output, restore ? PatchedHash : OriginalHash);
                        writeStarted = true;
                        ReplaceContents(input, output);
                        RequireHash(output, restore ? OriginalHash : PatchedHash);
                    }
                }
                string after = File.GetAccessControl(Target, AccessControlSections.Owner | AccessControlSections.Group |
                    AccessControlSections.Access).GetSecurityDescriptorSddlForm(AccessControlSections.Owner |
                        AccessControlSections.Group | AccessControlSections.Access);
                if (after != security) throw new InvalidOperationException("Unexpected security descriptor change.");
                if (ReadTrust() != OriginalTrust) throw new IOException("Process trust protection was not preserved.");
                WriteJson("application.json", new { status = restore ? "RESTORED" : "APPLIED", target = Target,
                    targetHash = restore ? OriginalHash : PatchedHash, aclPreserved = true, backup = Backup,
                    processTrustPreserved = true, uiVerified = false, time = DateTime.UtcNow.ToString("o") });
                Log(restore ? "RESTORED_OK" : "APPLIED_OK_ACL_UNCHANGED");
                return 0;
            }
            catch (Exception error)
            {
                if (writeStarted && !restore)
                {
                    Log("ROLLING_BACK_AFTER_WRITE_ERROR: " + error.Message);
                    using (var original = File.OpenRead(Backup))
                    using (var handle = OpenWritableTarget(temporarilyRelaxTrust))
                    {
                        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Rollback cannot open target");
                        using (var output = new FileStream(handle, FileAccess.ReadWrite))
                        { ReplaceContents(original, output); RequireHash(output, OriginalHash); }
                    }
                    WriteJson("application.json", new { status = "ROLLED_BACK", error = error.ToString(),
                        targetHash = OriginalHash, uiVerified = false, time = DateTime.UtcNow.ToString("o") });
                }
                throw;
            }
        }
    }

    static void ValidateInputs(bool restore)
    {
        if ((File.GetAttributes(Target) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Target must be an ordinary file.");
        RequireHash(Target, restore ? PatchedHash : OriginalHash);
        RequireHash(restore ? Backup : Candidate, restore ? OriginalHash : PatchedHash);
    }
    static Process[] ClientProcesses()
    {
        return Process.GetProcessesByName("ChatGPT").Where(p => {
            try { return String.Equals(p.MainModule.FileName, ClientExe, StringComparison.OrdinalIgnoreCase); }
            catch (Win32Exception) { return false; }
            catch (InvalidOperationException) { return false; }
        }).ToArray();
    }
    static void StopClient()
    {
        Log("STOPPING_AUTHORIZED_CODEX_INSTALLATION");
        var clients = ClientProcesses();
        foreach (var process in clients)
            try { if (process.MainWindowHandle != IntPtr.Zero) process.CloseMainWindow(); }
            catch (InvalidOperationException) { }
        Thread.Sleep(5000);
        // Windows may minimize on close. Only the exact authorized installation is terminated.
        foreach (var process in ClientProcesses())
            try { process.Kill(); process.WaitForExit(5000); }
            catch (InvalidOperationException) { }
        if (ClientProcesses().Any()) throw new IOException("Codex processes have not exited; no file was written.");
        Log("CLIENT_STOPPED");
    }
    static void ReplaceContents(FileStream input, FileStream output)
    {
        input.Position = 0; output.Position = 0;
        input.CopyTo(output, 1024 * 1024);
        output.SetLength(input.Length);
        output.Flush(true);
    }
    static void RequireHash(string path, string expected)
    { using (var input = File.OpenRead(path)) RequireHash(input, expected); }
    static void RequireHash(FileStream input, string expected)
    {
        input.Position = 0;
        using (var sha = SHA256.Create())
        {
            string actual = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
            if (actual != expected) throw new IOException("SHA-256 mismatch: " + input.Name);
        }
        input.Position = 0;
    }
    static void Log(string message)
    { File.AppendAllText(Path.Combine(Prepared, "application.log"), DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine); }
    static void WriteJson(string name, object value)
    { File.WriteAllText(Path.Combine(Prepared, name), Json.Serialize(value), new UTF8Encoding(false)); }

    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string name, uint type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string name, uint type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    static SafeFileHandle OpenTarget(uint share, out int error)
    {
        var handle = CreateFile(Target, 0xC0000000, share, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        error = Marshal.GetLastWin32Error();
        return handle;
    }
    static string ReadTrust()
    {
        IntPtr owner, group, dacl, sacl, descriptor, text; uint length;
        uint error = GetNamedSecurityInfo(Target, 1, 0x80, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, "Read process trust label");
        try
        {
            if (!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 0x80, out text, out length))
                throw new Win32Exception();
            try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
        }
        finally { LocalFree(descriptor); }
    }
    static SafeFileHandle OpenWritableTarget(bool temporarilyRelaxTrust)
    {
        int error;
        var handle = OpenTarget(0, out error);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();
        if (!temporarilyRelaxTrust || error != 5) throw new Win32Exception(error, "Open exact archive for write");
        if (ReadTrust() != OriginalTrust) throw new IOException("Unexpected trust label before opt-in operation.");
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = GetNamedSecurityInfo(Target, 1, 0x80, out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) throw new Win32Exception((int)result);
        IntPtr emptyAcl = Marshal.AllocHGlobal(8);
        bool changed = false;
        SafeFileHandle writable = null;
        try
        {
            // A valid empty ACL. Only PROCESS_TRUST_LABEL_SECURITY_INFORMATION is set;
            // owner, DACL, audit entries and all directory protections are untouched.
            Marshal.Copy(new byte[] { 2, 0, 8, 0, 0, 0, 0, 0 }, 0, emptyAcl, 8);
            result = SetNamedSecurityInfo(Target, 1, 0x80, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, emptyAcl);
            if (result != 0) throw new Win32Exception((int)result, "Windows refused the approved temporary file trust change");
            changed = true;
            writable = OpenTarget(0, out error);
        }
        finally
        {
            try
            {
                if (changed)
                {
                    result = SetNamedSecurityInfo(Target, 1, 0x80, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
                    if (result != 0 || ReadTrust() != OriginalTrust)
                    {
                        if (writable != null) writable.Dispose();
                        Log("CRITICAL: process trust restoration failed; no archive bytes have been written.");
                        throw new Win32Exception((int)result, "Restore original process trust protection");
                    }
                    Log("EXACT_FILE_TRUST_RESTORED_BEFORE_CONTENT_WRITE");
                }
            }
            finally { Marshal.FreeHGlobal(emptyAcl); LocalFree(descriptor); }
        }
        if (writable == null || writable.IsInvalid)
        {
            if (writable != null) writable.Dispose();
            throw new Win32Exception(error, "Write handle unavailable after restoring trust protection");
        }
        return writable;
    }
    static void EnablePrivilege(string name)
    {
        IntPtr token;
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x28, out token)) throw new Win32Exception();
        try
        {
            Luid luid;
            if (!LookupPrivilegeValue(null, name, out luid)) throw new Win32Exception();
            var state = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
            if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            int error = Marshal.GetLastWin32Error();
            if (error != 0) throw new Win32Exception(error, "Privilege unavailable: " + name);
        }
        finally { CloseHandle(token); }
    }
}
