'use strict';

// The Recycle Bin: the PowerShell scripts and runners, the volume checks and rm (#315).

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { BARE_DEVICE_NAME } = require('./windowsNames');
const { config, FcError, claim, ensureItemExists, entryKey, isSameOrUnder, pathKey, perform, realKey, rejectBareDeviceArgs } = require('./base');

// Among the items directly inside the folders given under the target, it returns, as a Map of { relative path from the target -> attribute bits }, those that have the hidden (2) or system (4) attribute (#65).
// Node cannot read file attributes, so it calls PowerShell once. Which folders to look at is the folder list that walk decided (relative paths, '' for the target itself).
// If PowerShell recursed on its own, the judgment would split on folders that have the ReparsePoint attribute but are not links, such as the OneDrive folder (first review).
// Names are passed through stdin and stdout as UTF-16 converted to base64, so that they are exchanged regardless of the code page. It uses a \\?\ path so that it reads even past 260 characters.
// If even one folder cannot be read, it raises an error so that it does not proceed with only a partial view. If it is not Windows, it is an empty Map.
// It strips the trailing separator so that a path that keeps a trailing separator, such as a drive root (Q:\), does not get its relative path cut (first review).
function hiddenOrSystemEntries(dir, folders = ['']) {
  if (!config.isWindows) return new Map();
  const full = path.resolve(dir).replace(/[\\/]+$/, '');
  const root = full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
  const script =
    "$ErrorActionPreference = 'Stop'; try { $root = $env:FC_ROOT; $u = [Text.Encoding]::Unicode; " +
    'foreach ($line in $input) { if (-not $line) { continue }; $rel = $u.GetString([Convert]::FromBase64String($line)); if ($rel -eq ".") { $rel = "" }; ' +
    'foreach ($e in [IO.DirectoryInfo]::new($root + "\\" + $rel).EnumerateFileSystemInfos()) { $a = [int]$e.Attributes -band 6; ' +
    'if ($a) { $name = if ($rel) { $rel + "\\" + $e.Name } else { $e.Name }; "$a " + [Convert]::ToBase64String($u.GetBytes($name)) } } } } catch { exit 3 }';
  // An empty relative path becomes an empty line, so the target itself is passed as '.'. A real folder name cannot be '.'.
  const input = folders.map((folder) => Buffer.from(folder === '' ? '.' : folder, 'utf16le').toString('base64')).join('\n') + '\n';
  let output;
  try {
    output = childProcess.execFileSync(config.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_ROOT: root },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    throw new FcError(`Cannot check hidden and system attributes: ${full} (${err.code ?? err.status})`);
  }
  const found = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([246]) ([A-Za-z0-9+/=]+)$/.exec(line.trim());
    if (match) found.set(Buffer.from(match[2], 'base64').toString('utf16le'), Number(match[1]));
  }
  return found;
}

// The limit of the path length that the Recycle Bin move (Microsoft.VisualBasic DeleteFile) accepts. If it exceeds MAX_PATH (260, including the trailing NUL),
// it always fails whether the file name is Korean or English (confirmed in #101). The length is the number of UTF-16 characters.
const MAX_RECYCLE_PATH = 259;

// There is no time limit on the Recycle Bin move (#97). A locked file and a folder that holds a locked file failed within 1 to 2 seconds without a dialog
// (build 26200, checked in an interactive session), and the Recycle Bin move takes time in proportion to the number of files even on the same volume (15 to 25 seconds for a 50,000-file folder).
// When PowerShell was ended midway, some files in the folder were left in neither the original place nor the Recycle Bin (measured in the first review).

// It finds a file, inside a file or folder, that another program opened while blocking writes and deletes (#97). Opening such a file for writing gives EBUSY.
// It is called only to report the reason when the Recycle Bin move failed. If there are many items (files and folders), it stops reading after limit of them.
// It does not follow links or junctions. A read-only file gives EPERM, so it is not seen as in use, and opening it alone does not change the content.
const MAX_BUSY_PROBE = 10000;

function busyInside(target, limit = MAX_BUSY_PROBE) {
  const busy = (file) => {
    try {
      fs.closeSync(fs.openSync(file, 'r+'));
      return false;
    } catch (err) {
      return err.code === 'EBUSY';
    }
  };
  try {
    const stat = fs.lstatSync(target);
    if (stat.isFile()) return busy(target) ? path.basename(target) : undefined;
    if (!stat.isDirectory()) return undefined;
    const stack = [target];
    let seen = 0;
    while (stack.length > 0 && seen < limit) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && busy(full)) return path.relative(target, full);
        if (++seen >= limit) break;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// It returns the path to pass to the Recycle Bin move. If it is certain that it cannot be sent, it refuses and states the reason (#129).
// rm checks everything with this before the preview and before running on several targets, so that the preview and the real result are the same and it does not stop after deleting only part.
// - \\?\D:\... prefix: the Recycle Bin move cannot accept this form and always fails. It strips the prefix only when it still points to the same file after stripping.
//   If the prefixed path Node normalized differs from the stripped path (\\?\C:\x\..\..\y and so on), it refuses. Other forms such as \\?\UNC\ and \\.\ are also refused.
//   remove refuses device names first with rejectBareDeviceArgs.
// - A path that holds a name ending in a dot or a space: refused with or without the prefix (first review). Node sees the literal dot.,
//   but the Recycle Bin move (PowerShell 5.1) opens dot with the trailing dot and space removed, so if a dot is beside it, it sent that file to the Recycle Bin (measured).
// - A path longer than 259 characters (MAX_RECYCLE_PATH)
function recycleTarget(target) {
  let plain = target;
  const prefixed = /^[\\/]{2}[?.][\\/]/.test(target);
  if (prefixed) {
    const drive = /^[\\/]{2}\?[\\/]([A-Za-z]:[\\/].*)$/s.exec(target);
    if (!drive) throw new FcError(`A path of this form cannot be sent to the Recycle Bin: ${target}. Specify it again as a drive-letter path (D:\\...).`);
    plain = drive[1];
    if (path.resolve(target).toUpperCase() !== `\\\\?\\${path.resolve(plain)}`.toUpperCase()) {
      throw new FcError(`Removing the \\\\?\\ prefix would point somewhere else, so it cannot be sent to the Recycle Bin: ${target}. Specify it again as a path without . or ..`);
    }
  }
  const full = path.resolve(plain);
  const odd = full.split(path.sep).slice(1).find((part) => /[. ]$/.test(part));
  if (odd !== undefined) {
    // For a UNC path (\\server\share), the \\?\UNC\server\share form is the prefixed path (second review).
    const long = full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
    const how = prefixed ? '' : ` To rename it, give fctl rename the \\\\?\\ prefixed path (${long}).`;
    throw new FcError(`It cannot be sent to the Recycle Bin because of a name ending with a dot or space (${odd}). Sending to the Recycle Bin points to another name with the trailing dot or space removed.${how || ' Give fctl rename this prefixed path, rename it, and delete again.'} To skip the Recycle Bin, use --permanent: ${target}`);
  }
  if (full.length > MAX_RECYCLE_PATH) throw new FcError(`The path is ${full.length} characters, so it cannot be sent to the Recycle Bin (up to ${MAX_RECYCLE_PATH}): ${full}`);
  return full;
}

function moveToRecycleBin(target, { permanentHint = false } = {}) {
  const full = recycleTarget(target);
  // In a non-interactive run (a service, a scheduled task), this API deletes permanently without going through the Recycle Bin, so it refuses.
  // On failure, it sends the reason text Windows gave as UTF-16 base64 and ends with 77. stderr comes out in the code page and Korean is garbled (#97).
  // The HResult of the exception comes out as 0x800736B7 for both locked files and folders and cannot separate the reasons, so it is not used.
  // Right before deleting, inside PowerShell, it looks at the volume's Recycle Bin setting and the size, and if it would be deleted permanently, it does not delete and ends with 78 (#81).
  // The path is passed in an environment variable to avoid quoting problems.
  try {
    childProcess.execFileSync(config.powershell, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], {
      env: { ...process.env, FC_TARGET: full },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // PowerShell's stderr comes out in the code page and Korean is garbled, so the cases are separated by exit code, and for 77 the reason text is received on stdout (UTF-16 base64).
    if (err.status === 75) throw new FcError('Cannot send to the Recycle Bin outside an interactive session.');
    if (err.status === 78) throw new FcError(permanentRefusal(full, refusalReason(decodeReason(err.stdout)), permanentHint));
    // If a folder holds an item that is exactly a device name, the Recycle Bin move fails for the whole folder (#135). It is searched for only on failure and reported as the reason.
    const inside = bareDeviceInside(full);
    if (inside !== undefined) throw new FcError(`Could not send to the Recycle Bin. It may have failed because of an item with a device name inside (${inside}): ${full}. Rename that item with fctl rename and delete again.`);
    const found = oddNameInside(full);
    if (found !== undefined) {
      // What to change is the first component that ends in a dot or a space (for dot./a.txt, dot.).
      const parts = found.split(path.sep);
      const odd = parts.slice(0, parts.findIndex((part) => /[. ]$/.test(part)) + 1).join(path.sep);
      const inner = path.join(full, odd);
      const long = inner.startsWith('\\\\') ? `\\\\?\\UNC\\${inner.slice(2)}` : `\\\\?\\${inner}`;
      throw new FcError(`Could not send to the Recycle Bin. A name ending with a dot or space inside (${odd}) made the whole folder fail: ${full}. Give fctl rename the \\\\?\\ prefixed path (${long}), rename it, and delete again.`);
    }
    if (err.status === 77) throw new FcError(recycleFailureMessage(full, decodeReason(err.stdout)));
    // For a failure whose reason is unknown, it throws the original error as it is, so that the caller can add context (extracted but... and so on).
    // However, it is changed so that the full command and a message that contains garbled stderr are not shown (#97).
    err.message = `Could not send to the Recycle Bin: ${full} (PowerShell exit code ${err.status ?? err.code})`;
    throw err;
  }
}

// The message to report when the Recycle Bin move failed with a Windows reason. If a file in use exists, its name is attached (#97).
function recycleFailureMessage(full, reason) {
  const busy = busyInside(full);
  const isDir = fs.lstatSync(full, { throwIfNoEntry: false })?.isDirectory();
  const where = isDir ? `A file inside is in use by another program: ${busy}` : 'Another program is using this file';
  const note = busy === undefined ? '' : ` ${where}. Close that program and delete again.`;
  return `Could not send to the Recycle Bin: ${full}${reason ? ` (${reason})` : ''}.${note}`;
}

// It decodes the reason text that PowerShell sent as UTF-16 base64 into one line and returns it. If it is missing or garbled, it is an empty string.
function decodeReason(stdout) {
  const line = String(stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
  if (!/^[A-Za-z0-9+/=]+$/.test(line)) return '';
  return Buffer.from(line, 'base64').toString('utf16le').replace(/\s+/g, ' ').trim().replace(/[.。]$/, '');
}

// It sends several empty folders to the Recycle Bin with one PowerShell run (#67). Starting PowerShell for each folder takes 1 to 2 seconds each, which becomes hours when there are many folders.
// Even if the caller finished the check before deleting, sending in a batch makes the gap between the check and the deletion longer, so PowerShell checks again for each folder right before deleting.
// - Whether the real path (GetFinalPathNameByHandle) is the same as the path passed in. If a folder above was replaced by a junction and points elsewhere, it does not delete.
//   Even with the ReparsePoint attribute, as for the OneDrive folder, if it is not a link the real path stays the same, so it deletes.
// - Whether it is still a folder, whether it holds no file other than allowedNames (folder settings files, lower case), and whether a subfolder was replaced by a link
// For the path, it passes the real path that Node obtained with realpath. The result is a list of { path, status } in the order passed.
// status: ok (sent to the Recycle Bin), moved, notdir, filled, gone, error, timeout (the folder being processed when the time limit hit), pending (a folder after it that was not touched)
// It reports separately as pending the folders after the one in a batch that hit the time limit, so the caller can send them again. The same folder does not block a whole batch every time (first review).
// script is passed only when a test replaces DeleteDirectory and runs the checking part with real PowerShell.
const FOLDER_BATCH_STATUS = new Set(['ok', 'moved', 'notdir', 'filled', 'gone', 'error']);

// The parts that the batch scripts (empty folders, files) share (#362): the start (a non-interactive session exits 75, a missing Visual Basic assembly exits 76)
// and the two functions that turn a path into the long path form and back. Each script keeps its own C# type and the rest.
const PS_START = String.raw`$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { exit 75 }
try { Add-Type -AssemblyName Microsoft.VisualBasic } catch { exit 76 }
`;
const PS_PATH_FUNCTIONS = String.raw`function Long([string]$p) { if ($p.StartsWith('\\')) { return '\\?\UNC\' + $p.Substring(2) }; return '\\?\' + $p }
function Plain([string]$p) { if ($p.StartsWith('\\?\UNC\')) { return '\\' + $p.Substring(8) }; if ($p.StartsWith('\\?\')) { return $p.Substring(4) }; return $p }
`;

// The start failures of the batch scripts, the same for every runner. checks says what the script checks, notSent what was not sent.
function scriptStartFailure(err, checks, notSent) {
  if (err.status === 75) return new FcError('Cannot send to the Recycle Bin outside an interactive session.');
  if (err.status === 76) return new FcError(`PowerShell could not create the type used to check ${checks} (locked-down environment, etc.), so ${notSent} not sent to the Recycle Bin.`);
  return undefined;
}

const RECYCLE_FOLDERS_SCRIPT = String.raw`${PS_START}try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class FcFinalPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint l, uint f);
  public static string Get(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      StringBuilder b = new StringBuilder(32768);
      return GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0) == 0 ? null : b.ToString();
    }
  }
}' } catch { exit 76 }
$u = [Text.Encoding]::Unicode
$allowed = @(($env:FC_ALLOWED -split '\|') | Where-Object { $_ })
${PS_PATH_FUNCTIONS}function Same([string]$p) { $f = [FcFinalPath]::Get((Long $p)); return ($f -ne $null) -and [string]::Equals((Plain $f), $p, [StringComparison]::OrdinalIgnoreCase) }
function Check([string]$p) {
  $stack = [Collections.Stack]::new(); $stack.Push($p)
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    foreach ($e in [IO.DirectoryInfo]::new((Long $d)).EnumerateFileSystemInfos()) {
      $child = $d + '\' + $e.Name
      if (-not ([int]$e.Attributes -band 16)) { if ($allowed -notcontains $e.Name.ToLowerInvariant()) { return 'filled' }; continue }
      if (-not (Same $child)) { return 'filled' }
      $stack.Push($child)
    }
  }
  return $null
}
foreach ($line in $input) {
  if (-not $line) { continue }
  $p = $u.GetString([Convert]::FromBase64String($line))
  $status = 'error'
  try {
    $long = Long $p
    if (-not [IO.Directory]::Exists($long)) { if ([IO.File]::Exists($long)) { $status = 'notdir' } else { $status = 'gone' } }
    elseif (-not (Same $p)) { $status = 'moved' }
    else {
      $found = Check $p
      if ($found) { $status = $found }
      else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin'); $status = 'ok' }
    }
  } catch { $status = 'error' }
  [Console]::Out.WriteLine($status + ' ' + $line)
  [Console]::Out.Flush()
}`;

function recycleEmptyFolders(folders, { allowedNames = [], timeoutMs = 30 * 1000 + folders.length * 1000, script = RECYCLE_FOLDERS_SCRIPT } = {}) {
  if (folders.length === 0) return [];
  const input = folders.map((folder) => Buffer.from(folder, 'utf16le').toString('base64')).join('\n') + '\n';
  let output;
  let timedOut = false;
  try {
    output = childProcess.execFileSync(config.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_BATCH: '1', FC_ALLOWED: allowedNames.join('|') },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // In a locked-down environment (Constrained Language Mode, AppLocker), a C# type cannot be created (first review).
    const startFailure = scriptStartFailure(err, 'paths', 'the empty folder was');
    if (startFailure) throw startFailure;
    // Even on a time limit (such as when it stalls at an error dialog) or a mid-run failure, it uses the results of the folders already reported.
    timedOut = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
    output = typeof err.stdout === 'string' ? err.stdout : String(err.stdout ?? '');
    if (!timedOut && output === '') throw err;
  }
  const done = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\w+) ([A-Za-z0-9+/=]+)$/.exec(line.trim());
    if (match && FOLDER_BATCH_STATUS.has(match[1])) done.set(Buffer.from(match[2], 'base64').toString('utf16le'), match[1]);
  }
  let first = true;
  return folders.map((folder) => {
    if (done.has(folder)) return { path: folder, status: done.get(folder) };
    if (!timedOut) return { path: folder, status: 'error' };
    const status = first ? 'timeout' : 'pending';
    first = false;
    return { path: folder, status };
  });
}

// It looks in advance whether it can go through the Recycle Bin. If it fails, it returns unknown (null) so that the caller does not delete.
// The returned value is { interactive, driveType }. driveType is a .NET DriveType name such as Fixed, Removable, or Network.
// The returned value also includes that volume's Recycle Bin setting (#100). nukeOnDelete is whether "Don't move files to the Recycle Bin. Remove files immediately when deleted" is on,
// and maxCapacity is the Recycle Bin maximum size (in bytes). If it cannot be read, it is null.
// Measured (build 26200, interactive): on a volume where one item (a file, or the total inside for a folder) exceeds maxCapacity or nukeOnDelete is on,
// the Recycle Bin move deleted permanently without asking and finished as a success (with a D: capacity of 7164MB, 7100MB went to the Recycle Bin and 7200MB was deleted permanently).
// The amount already in the Recycle Bin did not matter (even when the total exceeded the capacity, it neither emptied existing items nor deleted the new one).
// The volume is found with GetVolumePathName, so under a volume mount folder it also looks at that volume's setting. The setting is, per user (HKCU),
// NukeOnDelete and MaxCapacity (MB) of BitBucket\Volume\{GUID}. If the policy (NoRecycleFiles) is on, it is seen as remove-immediately,
// and if the size was set by policy (RecycleBinSize), the size is treated as unknown.
// It decides the volume type ($type) and the Recycle Bin setting ($nuke: '0', '1', or '', $cap: MB or '') of $p. RECYCLE_STATE_SCRIPT and the Recycle Bin move script use it together (#81).
const VOLUME_STATE_PS = String.raw`$names = @('Unknown', 'NoRootDirectory', 'Removable', 'Fixed', 'Network', 'CDRom', 'Ram')
$type = 'Unknown'; $nuke = ''; $cap = ''
try {
  if (-not ('FcVolume.Native' -as [type])) { Add-Type -Namespace FcVolume -Name Native -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetVolumePathNameW(string f, System.Text.StringBuilder b, uint n);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetVolumeNameForVolumeMountPointW(string m, System.Text.StringBuilder b, uint n);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetDriveTypeW(string r);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
[StructLayout(LayoutKind.Sequential)] struct TagInfo { public uint Attr, ReparseTag; }
[DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle h, int c, out TagInfo b, uint n);
public static bool IsLink(string p) {
  using (var h = CreateFileW(p, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
    if (h.IsInvalid) return false;
    TagInfo t;
    if (!GetFileInformationByHandleEx(h, 9, out t, 8)) return false;
    return (t.Attr & 0x400) != 0 && (t.ReparseTag == 0xA000000C || t.ReparseTag == 0xA0000003);
  }
}' }
  $b = New-Object Text.StringBuilder 1024
  $root = if ([FcVolume.Native]::GetVolumePathNameW($p, $b, 1024)) { $b.ToString() } else { [IO.Path]::GetPathRoot($p) }
  $type = $names[[int][FcVolume.Native]::GetDriveTypeW($root)]
  $g = New-Object Text.StringBuilder 1024
  if ([FcVolume.Native]::GetVolumeNameForVolumeMountPointW($root, $g, 1024) -and ($g.ToString() -match '(\{[0-9A-Fa-f-]+\})')) {
    $k = Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $matches[1]) -ErrorAction SilentlyContinue
    if ($k -and $k.NukeOnDelete -ne $null) { $nuke = [string][int]$k.NukeOnDelete }
    if ($k -and $k.MaxCapacity -ne $null) { $cap = [string][long]$k.MaxCapacity }
  }
  foreach ($hive in 'HKLM:', 'HKCU:') {
    $pol = Get-ItemProperty -LiteralPath ($hive + '\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer') -ErrorAction SilentlyContinue
    if ($pol -and [int]$pol.NoRecycleFiles -eq 1) { $nuke = '1' }
    if ($pol -and $pol.RecycleBinSize -ne $null) { $cap = '' }
  }
} catch { $type = 'Unknown' }`;

// It sends several files to the Recycle Bin with one PowerShell run (#194). Starting PowerShell for each file takes 0.5 to 0.6 second per file, but
// bundled it took 1.6 seconds for 50 (measured on build 26200). Sending in a batch makes the gap between Node's check and the real deletion longer, so PowerShell checks again for each file right before deleting.
// - Whether the real path (GetFinalPathNameByHandle) is the same as the path passed in. If a folder above was replaced by a junction and points elsewhere, it does not delete (moved).
// - Whether it is still a file (not a folder or link, notfile) and whether it equals the fileStamp from the judgment (file ID, size, modification and change times in ns) (changed).
//   It looks at a link only when, as in Node, the reparse tag is a symbolic link, a junction, or an app execution link. Files in the OneDrive folder, even downloaded ones, carry a reparse attribute
//   (a cloud file tag), so looking at the attribute alone would leave all of them undeleted (first review).
//   The value PowerShell made was literally the same as Node's fileStamp on C: (NTFS) and D: (ReFS) (measured).
// Interrupting the Recycle Bin move midway can lose files, so there is no time limit (#97). It sends the result one line at a time as each file finishes.
// items is a list of { path, stamp, keep? } and path is a path that went through recycleTarget. The result is a list of { path, status, reason } in the order passed.
// If keep({ path, stamp }) is given, right before deleting it also checks that the real path, the file-ness, and the fileStamp of that file (the file to keep of remove-duplicates) are unchanged,
// and if different, it does not delete (keepchanged, #216). Even if the file to keep changes in the middle of a batch, the copies are not deleted.
// status: ok (sent to the Recycle Bin), moved, notfile, changed, gone, keepchanged, error (the Windows reason is in reason), unknown (PowerShell ended midway and the result is not known)
// permanent: it looked at the volume's Recycle Bin setting again right before deleting and it would be deleted permanently, so it did not delete (#236). reason is the reason sentence (starting with "because ...") of the same judgment as RECYCLE_SCRIPT.
// Even if "remove immediately" is turned on or the maximum size is reduced after the judgment at the planning stage and before running, it does not delete. The setting is read once, the first time each volume is met in a batch.
const FILE_BATCH_STATUS = new Set(['ok', 'moved', 'notfile', 'changed', 'gone', 'keepchanged', 'permanent', 'error']);

const RECYCLE_FILES_SCRIPT = String.raw`${PS_START}try { Add-Type -ReferencedAssemblies System.Numerics -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class FcFileCheck {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint l, uint f);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation, Access, Write, Change; public uint Attr; }
  [StructLayout(LayoutKind.Sequential)] struct Standard { public long Alloc, End; public uint Links; public byte Del, Dir; }
  [StructLayout(LayoutKind.Sequential)] struct ById { public uint Attr, C1, C2, A1, A2, W1, W2, Vol, SizeHigh, SizeLow, Links, IdHigh, IdLow; }
  [StructLayout(LayoutKind.Sequential)] struct Tag { public uint Attr, ReparseTag; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Basic b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Standard b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Tag b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out ById b);
  static string Ns(long ft) { return ((System.Numerics.BigInteger)(ft - 116444736000000000L) * 100).ToString(); }
  public static string Final(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      StringBuilder b = new StringBuilder(32768);
      return GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0) == 0 ? null : b.ToString();
    }
  }
  public static string Stamp(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      Basic b; Standard s; ById i; Tag t;
      if (!GetFileInformationByHandleEx(h, 0, out b, (uint)Marshal.SizeOf(typeof(Basic)))) return null;
      if (!GetFileInformationByHandleEx(h, 1, out s, (uint)Marshal.SizeOf(typeof(Standard)))) return null;
      if (!GetFileInformationByHandleEx(h, 9, out t, (uint)Marshal.SizeOf(typeof(Tag)))) return null;
      if (!GetFileInformationByHandle(h, out i)) return null;
      if ((b.Attr & 0x10) != 0) return "notfile";
      if ((b.Attr & 0x400) != 0 && (t.ReparseTag == 0xA000000C || t.ReparseTag == 0xA0000003 || t.ReparseTag == 0x8000001B)) return "notfile";
      ulong id = ((ulong)i.IdHigh << 32) | i.IdLow;
      return id + ":" + s.End + ":" + Ns(b.Write) + ":" + Ns(b.Change);
    }
  }
}' } catch { exit 76 }
$u = [Text.Encoding]::Unicode
${PS_PATH_FUNCTIONS}function Same([string]$k, [string]$stamp) {
  $kl = Long $k
  if (-not [IO.File]::Exists($kl)) { return $false }
  $f = [FcFileCheck]::Final($kl)
  if (($f -eq $null) -or -not [string]::Equals((Plain $f), $k, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  return ([FcFileCheck]::Stamp($kl) -eq $stamp)
}
# It reads the volume's Recycle Bin setting (#236). Files in the same folder are on the same volume, so it looks only once per folder in a batch, the first time.
# Reading the registry takes about 40ms per folder (measured in the first review), so if the volume root (GetVolumePathName) is the same, it reuses the setting it read.
function VolumeState([string]$p) {
${VOLUME_STATE_PS}
  return @($type, $nuke, $cap, $root)
}
$volumes = @{}; $roots = @{}
function VolumeOf([string]$dir) {
  if ('FcVolume.Native' -as [type]) {
    $b = New-Object Text.StringBuilder 1024
    if ([FcVolume.Native]::GetVolumePathNameW($dir, $b, 1024) -and $roots.ContainsKey($b.ToString())) { return $roots[$b.ToString()] }
  }
  $state = VolumeState $dir
  if ($state[3] -and $state[0] -ne 'Unknown') { $roots[$state[3]] = $state }
  return $state
}
# If deleting would be permanent, it returns the same marker as RECYCLE_SCRIPT (type|kind, nuke, cap|MB, unknown); otherwise $null.
function PermanentMark([string]$p, [long]$size) {
  $dir = [IO.Path]::GetDirectoryName($p)
  if (-not $volumes.ContainsKey($dir)) { $volumes[$dir] = VolumeOf $dir }
  $type, $nuke, $cap, $root = $volumes[$dir]
  if ($type -ne 'Fixed') { return 'type|' + $type }
  if ($nuke -ne '' -and $nuke -ne '0') { return 'nuke' }
  $limit = if ($cap -ne '') { [long]$cap * 1MB } else { 1GB - 1 }
  if ($size -gt $limit) { if ($cap -ne '') { return 'cap|' + $cap } else { return 'unknown' } }
  return $null
}
foreach ($line in $input) {
  if (-not $line) { continue }
  $parts = $line.Split(' ')
  $status = 'error'; $reason = ''
  try {
    # The fields are the copy path and stamp (2), or also the path and stamp of the file to keep (4). Anything else is not deleted, so that the check of the file to keep is not skipped (first review).
    if ($parts.Length -ne 2 -and $parts.Length -ne 4) { throw 'bad input line' }
    $p = $u.GetString([Convert]::FromBase64String($parts[0]))
    $long = Long $p
    if (-not [IO.File]::Exists($long)) { if ([IO.Directory]::Exists($long)) { $status = 'notfile' } else { $status = 'gone' } }
    else {
      $final = [FcFileCheck]::Final($long)
      $now = [FcFileCheck]::Stamp($long)
      if (($final -eq $null) -or -not [string]::Equals((Plain $final), $p, [StringComparison]::OrdinalIgnoreCase)) { $status = 'moved' }
      elseif ($now -eq 'notfile') { $status = 'notfile' }
      elseif ($now -ne $parts[1]) { $status = 'changed' }
      elseif (($parts.Length -ge 4) -and -not (Same ($u.GetString([Convert]::FromBase64String($parts[2]))) $parts[3])) { $status = 'keepchanged' }
      elseif (($mark = PermanentMark $p ([long]$now.Split(':')[1])) -ne $null) { $status = 'permanent'; $reason = [Convert]::ToBase64String($u.GetBytes($mark)) }
      else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin'); $status = 'ok' }
    }
  } catch { $status = 'error'; $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; $reason = [Convert]::ToBase64String($u.GetBytes([string]$e.Message)) }
  [Console]::Out.WriteLine($status + ' ' + $parts[0] + ' ' + $reason)
  [Console]::Out.Flush()
}`;

function recycleFiles(items, { script = RECYCLE_FILES_SCRIPT } = {}) {
  if (items.length === 0) return [];
  const b64 = (p) => Buffer.from(p, 'utf16le').toString('base64');
  const input = items.map((item) => `${b64(item.path)} ${item.stamp}${item.keep ? ` ${b64(item.keep.path)} ${item.keep.stamp}` : ''}`).join('\n') + '\n';
  let output;
  let failure;
  try {
    output = childProcess.execFileSync(config.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_RECYCLE_FILES: '1' },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const startFailure = scriptStartFailure(err, 'files', 'they were');
    if (startFailure) throw startFailure;
    // Even if it ended midway, it uses the results of files already reported. For files not reported, the result is not known.
    output = typeof err.stdout === 'string' ? err.stdout : String(err.stdout ?? '');
    failure = err.status == null && err.signal ? `PowerShell ended with ${err.signal}` : `PowerShell exit code ${err.status ?? err.code}`;
  }
  const done = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\w+) ([A-Za-z0-9+/=]+) ?([A-Za-z0-9+/=]*)$/.exec(line.trim());
    if (!match || !FILE_BATCH_STATUS.has(match[1])) continue;
    const reason = decodeReason(match[3]);
    done.set(Buffer.from(match[2], 'base64').toString('utf16le'), { status: match[1], reason: match[1] === 'permanent' ? refusalReason(reason) : reason });
  }
  return items.map((item) => ({ path: item.path, ...(done.get(item.path) ?? { status: 'unknown', reason: failure ?? 'PowerShell did not report a result' }) }));
}

function bareDeviceInside(dir) {
  return entryInside(dir, (part) => BARE_DEVICE_NAME.test(part));
}

// It finds an item inside a folder that holds a name ending in a dot or a space (#190). The Recycle Bin move (PowerShell 5.1) cannot open such a name, so for the whole folder
// it fails with "지정한 파일을 찾을 수 없습니다" (Windows message: "The specified file cannot be found") and moves nothing (confirmed on build 26200). It is searched for only on failure and reported as the reason.
// A path longer than 259 characters inside is not the cause of the failure. A folder that held 274 to 377 character paths also went to the Recycle Bin as is and stayed inside the Recycle Bin (measured).
function oddNameInside(dir) {
  return entryInside(dir, (part) => /[. ]$/.test(part));
}

// Among the items in a folder, it returns the relative path of the first item where one path component satisfies test. If it is not a folder or cannot be read, it is undefined.
// It does not follow links or junctions (readdirSync recursive does not see a link as a folder).
function entryInside(dir, test) {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return undefined;
    return fs.readdirSync(dir, { recursive: true }).find((rel) => rel.split(path.sep).some(test));
  } catch {
    return undefined;
  }
}

const RECYCLE_STATE_SCRIPT = `$p = $env:FC_VOLUME
${VOLUME_STATE_PS}
[Environment]::UserInteractive.ToString() + '|' + $type + '|' + $nuke + '|' + $cap`;

// The same answer for several paths in one run (#376): FC_VOLUMES holds the paths joined by | (a Windows name cannot contain it), and each path gets one output line, in order.
// The type of the volume script is added once and the rest runs for each path, so one PowerShell start (about 0.5 second) serves every target of rm a b c.
const RECYCLE_STATES_SCRIPT = String.raw`foreach ($p in ($env:FC_VOLUMES -split '\|')) {
${VOLUME_STATE_PS}
[Environment]::UserInteractive.ToString() + '|' + $type + '|' + $nuke + '|' + $cap
}`;

// The PowerShell script of moveToRecycleBin. In a non-interactive run (a service, a scheduled task), this API deletes permanently without going through the Recycle Bin, so it ends with 75.
// Right before deleting, it looks at the volume's Recycle Bin setting and the size (for a folder, the total inside; links and junctions are not followed), and if it would be deleted permanently, it does not delete and
// sends a reason marker as UTF-16 base64 and ends with 78 (#81). If it is not a fixed disk or the type is unknown, type|type; if remove-immediately, nuke;
// if it exceeds the maximum size, cap|MB; if the maximum size is unknown and it is 1GB or more, unknown; if the size cannot be read, size.
// If the Recycle Bin move fails, it sends the reason text Windows gave as UTF-16 base64 and ends with 77. stderr comes out in the code page and Korean is garbled (#97).
// The HResult of the exception comes out as 0x800736B7 for both locked files and folders and cannot separate the reasons, so it is not used.
const RECYCLE_SCRIPT = `if (-not [Environment]::UserInteractive) { exit 75 }
$p = $env:FC_TARGET
${VOLUME_STATE_PS}
$u = [Text.Encoding]::Unicode
function Refuse([string]$why) { [Console]::Out.WriteLine([Convert]::ToBase64String($u.GetBytes($why))); exit 78 }
if ($type -ne 'Fixed') { Refuse ('type|' + $type) }
if ($nuke -ne '' -and $nuke -ne '0') { Refuse 'nuke' }
$limit = if ($cap -ne '') { [long]$cap * 1MB } else { 1GB - 1 }
$long = if ($p.StartsWith('\\\\')) { '\\\\?\\UNC\\' + $p.Substring(2) } else { '\\\\?\\' + $p }
$size = [long]0
try {
  $isLink = { param($x) ([int][IO.File]::GetAttributes($x) -band 1024) -and [FcVolume.Native]::IsLink($x) }
  if ([IO.Directory]::Exists($long) -and -not (& $isLink $long)) {
    $stack = [Collections.Stack]::new(); $stack.Push($long)
    while ($stack.Count -gt 0 -and $size -le $limit) {
      foreach ($e in [IO.DirectoryInfo]::new($stack.Pop()).EnumerateFileSystemInfos()) {
        if ([int]$e.Attributes -band 16) { if (-not (([int]$e.Attributes -band 1024) -and [FcVolume.Native]::IsLink($e.FullName))) { $stack.Push($e.FullName) } }
        elseif (-not (([int]$e.Attributes -band 1024) -and [FcVolume.Native]::IsLink($e.FullName))) { $size += $e.Length; if ($size -gt $limit) { break } }
      }
    }
  } elseif ([IO.File]::Exists($long) -and -not (& $isLink $long)) { $size = [IO.FileInfo]::new($long).Length }
} catch { Refuse 'size' }
if ($size -gt $limit) { if ($cap -ne '') { Refuse ('cap|' + $cap) } else { Refuse 'unknown' } }
try { Add-Type -AssemblyName Microsoft.VisualBasic
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } }
catch { $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; [Convert]::ToBase64String($u.GetBytes([string]$e.Message)); exit 77 }`;

// It turns the marker that RECYCLE_SCRIPT reported with 78 into a reason (a sentence starting with "because ...").
function refusalReason(mark) {
  const [kind, value] = mark.split('|');
  if (kind === 'type') return volumeTypeReason(value === 'Unknown' ? null : value);
  if (kind === 'nuke') return permanentDeleteReason({ nukeOnDelete: true }, 0);
  if (kind === 'cap') return permanentDeleteReason({ nukeOnDelete: false, maxCapacity: Number(value) * 1024 * 1024 }, Infinity);
  if (kind === 'unknown') return permanentDeleteReason({ nukeOnDelete: false, maxCapacity: null }, Infinity);
  return 'because the size could not be checked, so it is unknown whether it exceeds the Recycle Bin maximum size';
}

function volumeTypeReason(driveType) {
  return driveType === null || driveType === undefined
    ? 'because the drive type could not be checked, so it is unknown whether a Recycle Bin exists'
    : `because the drive (${driveType}) may have no Recycle Bin and the file could be permanently deleted`;
}

// hint is turned on only for commands that accept --permanent, like rm. extract-all and collapse do not accept --permanent (first review).
function permanentRefusal(full, why, hint = false) {
  const tail = hint ? ' To delete without the Recycle Bin, use --permanent.' : '';
  return `Not sent to the Recycle Bin: ${full}. It was not deleted ${why}.${tail}`;
}

// In the preview, it makes the same judgment as RECYCLE_SCRIPT (#81). If it would be deleted permanently it returns the reason, otherwise null.
function previewRefusal(full, state = recycleBinState(full)) {
  if (state.driveType !== 'Fixed') return volumeTypeReason(state.driveType);
  if (state.nukeOnDelete === true) return permanentDeleteReason(state, 0);
  const limit = state.maxCapacity ?? UNKNOWN_RECYCLE_LIMIT - 1;
  let size;
  try {
    size = sizeUpTo(full, limit);
  } catch {
    return refusalReason('size');
  }
  return permanentDeleteReason(state, size);
}

// The file size, or for a folder the total size of the files inside. It does not follow links or junctions, and stops counting if the total exceeds limit.
function sizeUpTo(full, limit) {
  const stat = fs.lstatSync(full);
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let size = 0;
  const stack = [full];
  while (stack.length > 0 && size <= limit) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) size += fs.lstatSync(child).size;
      if (size > limit) break;
    }
  }
  return size;
}

const unknownState = () => ({ interactive: null, driveType: null, nukeOnDelete: null, maxCapacity: null });

// One answer line of the state script -> { interactive, driveType, nukeOnDelete, maxCapacity }. A line that does not parse is the unknown state.
function parseVolumeState(line) {
  // It also accepts the form without a setting field (True|Fixed). Then the setting is treated as unknown.
  const found = /^(True|False)\|(\w+)(?:\|(\d*)\|(\d*))?\s*$/.exec(line);
  if (!found) return unknownState();
  const driveType = found[2] === 'Unknown' ? null : found[2];
  const nukeOnDelete = found[3] ? found[3] !== '0' : null;
  const maxCapacity = found[4] ? Number(found[4]) * 1024 * 1024 : null;
  return { interactive: found[1] === 'True', driveType, nukeOnDelete, maxCapacity };
}

function recycleBinState(target) {
  if (!config.isWindows) return unknownState();
  try {
    const output = childProcess.execFileSync(config.powershell, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_STATE_SCRIPT], {
      env: { ...process.env, FC_VOLUME: path.resolve(target) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60 * 1000,
    });
    return parseVolumeState(output);
  } catch {
    return unknownState();
  }
}

// The state of each target, in one PowerShell run for all of them (#376). Each target still gets its own answer (a volume mount folder is another volume
// with its own setting, which only Windows can tell), so nothing is cached by drive root. One target uses recycleBinState as before.
// If the run fails or an answer line is missing, that target's state is unknown, the same as when recycleBinState fails.
function recycleBinStates(targets) {
  if (targets.length === 1) return [recycleBinState(targets[0])];
  if (targets.length === 0 || !config.isWindows) return targets.map(unknownState);
  try {
    const output = childProcess.execFileSync(config.powershell, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_STATES_SCRIPT], {
      env: { ...process.env, FC_VOLUMES: targets.map((target) => path.resolve(target)).join('|') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60 * 1000 + targets.length * 2000,
    });
    const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
    return targets.map((_, i) => parseVolumeState(lines[i] ?? ''));
  } catch {
    return targets.map(unknownState);
  }
}

// The size to keep when the Recycle Bin capacity could not be confirmed. The default Recycle Bin capacity is about 5% of the volume, so it is 1GB for a 20GB volume.
const UNKNOWN_RECYCLE_LIMIT = 1024 * 1024 * 1024;

// It looks, by the volume setting (recycleBinState), at whether sending an item of size bytes to the Recycle Bin would delete it permanently (#100).
// If it would be deleted permanently, it returns the reason (a sentence starting with "because ..."), otherwise null. If the capacity is unknown, it is seen as permanent deletion from UNKNOWN_RECYCLE_LIMIT.
// fallback is the limit for when the capacity is unknown, and is changed only in tests.
function permanentDeleteReason(state, size, fallback = UNKNOWN_RECYCLE_LIMIT) {
  if (state.nukeOnDelete === true) return 'because this volume is set to remove files immediately instead of using the Recycle Bin, so it would be permanently deleted';
  const mb = (bytes) => `${Math.floor(bytes / (1024 * 1024))}MB`;
  if (state.maxCapacity !== null && state.maxCapacity !== undefined) {
    return size > state.maxCapacity ? `because it is larger than the Recycle Bin maximum size (${mb(state.maxCapacity)}), so Windows would permanently delete it without asking` : null;
  }
  return size >= fallback ? 'because it is 1GB or larger and the Recycle Bin maximum size could not be checked, so it could be permanently deleted' : null;
}

// If checkVolume is true, before deleting (including the preview) it looks at the volume's Recycle Bin setting and size for every target, and if any target would be deleted permanently,
// it deletes nothing and refuses (#81). On a real delete, the Recycle Bin move script looks once more right before deleting.
// Callers that already made the same judgment (remove-broken and so on) call it with false so that PowerShell is not started once more.
// permanentHint is whether to attach the --permanent hint to the refusal reason (only the rm command turns it on).
function remove(targets, { permanent = false, dryRun = false, checkVolume = true, permanentHint = false } = {}) {
  if (!permanent && !config.isWindows) {
    throw new FcError('Deleting to the Recycle Bin works only on Windows. To delete permanently, use --permanent');
  }
  const planned = new Set();
  // It checks every target before deleting anything (#129). In rm a b c, if only c cannot be sent, a and b are not deleted either and the reason is reported.
  // The preview goes through the same check, so it does not show a target that would really fail as "Move to the Recycle Bin".
  // Every target is validated first. An error is kept for its turn, so the first problem in target order is still the one reported (#129).
  // The volume setting of all targets that come before the first validation error is then read in one PowerShell run (#376).
  const validated = targets.map((target) => {
    try {
      ensureItemExists(target);
      // If deleted as is, only the current folder cannot be deleted and it fails, but before that the other items have already been deleted.
      // Deleting a link removes only the link, so it compares by the link itself. Comparing by text catches the current folder reached through a link (rm lnk, current folder lnk/s).
      if (isSameOrUnder(entryKey(target), realKey(process.cwd())) || isSameOrUnder(pathKey(target), pathKey(process.cwd()))) {
        throw new FcError(`Cannot delete the current folder or its parents: ${target}`);
      }
      if (!permanent) rejectBareDeviceArgs([target], 'cannot be sent to the Recycle Bin');
      // Permanent deletion deletes with Node (fs.rmSync), so it does not run the Recycle Bin path check.
      return { target, recycleAs: permanent ? undefined : recycleTarget(target) };
    } catch (err) {
      return { target, error: err };
    }
  });
  const firstError = validated.findIndex((item) => item.error !== undefined);
  const upToError = firstError === -1 ? validated : validated.slice(0, firstError);
  const states = !permanent && checkVolume ? recycleBinStates(upToError.map((item) => item.recycleAs)) : [];
  const checked = validated.map(({ target, recycleAs, error }, i) => {
    if (error !== undefined) throw error;
    if (!permanent && checkVolume) {
      const why = previewRefusal(recycleAs, states[i]);
      if (why !== null) throw new FcError(permanentRefusal(recycleAs, why, permanentHint));
    }
    if (dryRun) claim(planned, target);
    return { target, recycleAs };
  });
  return checked.map(({ target, recycleAs }) => {
    // If an earlier target contained this target and it was already deleted (rm a a/b), it reports that it does not exist, as before.
    if (!dryRun) ensureItemExists(target);
    if (permanent) return perform(`Delete permanently: ${target}`, dryRun, () => fs.rmSync(target, { recursive: true, force: true }));
    return perform(`Move to the Recycle Bin: ${target}`, dryRun, () => moveToRecycleBin(recycleAs, { permanentHint }));
  });
}

module.exports = {
  MAX_RECYCLE_PATH,
  RECYCLE_FILES_SCRIPT,
  RECYCLE_FOLDERS_SCRIPT,
  RECYCLE_SCRIPT,
  RECYCLE_STATE_SCRIPT,
  RECYCLE_STATES_SCRIPT,
  UNKNOWN_RECYCLE_LIMIT,
  bareDeviceInside,
  busyInside,
  decodeReason,
  hiddenOrSystemEntries,
  permanentDeleteReason,
  permanentRefusal,
  previewRefusal,
  recycleBinStates,
  recycleBinState,
  recycleEmptyFolders,
  recycleFailureMessage,
  recycleFiles,
  recycleTarget,
  remove,
  sizeUpTo,
};
