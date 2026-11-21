'use strict';

const os = require('node:os');
const path = require('node:path');

// Device names (#53). The rule measured on Windows 11 build 26200: only a name that is exactly a device name or has just one extension attached (nul.mp4, con.txt, com².mp4)
// is seen as a device by PowerShell. Names with two or more dots (Con.Air.1997.mkv, nul.tar.gz, COM¹.tar.gz), a name with a space before the dot (Nul .mp4), and COM0 and LPT0 are
// handled as the same file by PowerShell, tar.exe, and the Recycle Bin move. The Recycle Bin move script looks at whether it is a folder with Test-Path, so it follows the Test-Path criterion.
// CONIN$ and CONOUT$ are refused only when it is exactly that name.
// The narrow rule is used only on builds that were measured to behave that way (VERIFIED_NARROW_BUILDS). On every other build, including a newer one that was not checked,
// if a name such as nul.tar.gz opens as a device, a copy would vanish into the device and a move across drives would delete the original,
// so it refuses every name that starts with a device name, as before (#316). To add a build, see "Device names on a new Windows build" in the README.
const WINDOWS_DEVICE_NAME_WIDE = /^(con|prn|aux|nul|com[\d¹²³]|lpt[\d¹²³]|conin\$|conout\$) *(\.|$)/i;
const WINDOWS_DEVICE_NAME_NARROW = /^((con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.[^.]*)?|conin\$|conout\$)$/i;
// The builds where the narrow rule was measured: 26200 (Windows 11 25H2). FCTL_NARROW_DEVICE_BUILDS (comma separated build numbers) adds builds the person verified
// themselves, and is how the tests try an unknown build. It is read when the pattern is chosen, so a process sets it before it starts.
const VERIFIED_NARROW_BUILDS = new Set([26200]);

function narrowBuilds(env = process.env) {
  const extra = String(env.FCTL_NARROW_DEVICE_BUILDS ?? '').split(',').map((text) => text.trim()).filter((text) => /^\d+$/.test(text)).map(Number).filter((build) => Number.isSafeInteger(build) && build > 0);
  return new Set([...VERIFIED_NARROW_BUILDS, ...extra]);
}

// A device name exactly with no extension (nul, CON, Com1, lpt¹, CONIN$). Windows removes a trailing dot and space, so nul. and "com1 " are the same (#135).
// On build 26200, tar.exe failed by opening a device when it received such a name as an argument (nul, CON), and the Recycle Bin move also failed
// (nul, CON, PRN, AUX, Com1, LPT9, lpt¹, COM², "com1 ", CONIN$, CONOUT$). COM0 and LPT0 were files.
// Such a name inside a folder is bundled and extracted by tar.exe as a file.
const BARE_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)[. ]*$/i;

// os.release() puts the build number third, as in "10.0.26200". If it cannot read it, or the build is not a verified one, it uses the broad rule.
function deviceNamePattern(release = os.release(), env = process.env) {
  const build = Number(String(release).split('.')[2]);
  return Number.isInteger(build) && narrowBuilds(env).has(build) ? WINDOWS_DEVICE_NAME_NARROW : WINDOWS_DEVICE_NAME_WIDE;
}

const WINDOWS_DEVICE_NAME = deviceNamePattern();

// Windows removes a trailing dot and space from a name and opens it. So "com1 " and Nul.mp4. are the same devices as com1 and Nul.mp4 (#135).
// A stream (nul:x) creates the file with the name before :, so that name is also looked at.
function isDeviceName(part, pattern = WINDOWS_DEVICE_NAME) {
  return [part, part.split(':')[0]].some((name) => pattern.test(name) || pattern.test(name.replace(/[. ]+$/, '')));
}

// It returns the first name in the path that is a device name (leaving out the drive and UNC root). If none, or if it is not Windows, it is undefined.
function deviceNamePart(p, pattern = WINDOWS_DEVICE_NAME) {
  if (process.platform !== 'win32') return undefined;
  const full = path.resolve(p);
  return full.slice(path.parse(full).root.length).split(path.sep).find((part) => isDeviceName(part, pattern));
}

module.exports = { VERIFIED_NARROW_BUILDS, WINDOWS_DEVICE_NAME, BARE_DEVICE_NAME, deviceNamePattern, deviceNamePart, isDeviceName };
