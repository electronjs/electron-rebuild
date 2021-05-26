import * as cp from 'child_process';
import * as debug from 'debug';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as tar from 'tar';
import * as zlib from 'zlib';
import { ELECTRON_GYP_DIR } from './constants';
import { fetch } from './fetcher';
import { downloadLinuxSysroot } from './sysroot-fetcher';
import { downloadLibcxxHeaders, downloadLibcxxObjects } from './libcxx-fetcher';

const d = debug('electron-rebuild');

const CDS_URL = 'https://commondatastorage.googleapis.com/chromium-browser-clang';

function getPlatformUrlPrefix(hostOS: string) {
  const prefixMap = {
      'linux': 'Linux_x64',
      'darwin': 'Mac',
      'win32': 'Win',
  }
  return CDS_URL + '/' + prefixMap[hostOS] + '/'
}

function getClangDownloadURL(packageFile: string, packageVersion: string, hostOS: string) {
  const cdsFile = `${packageFile}-${packageVersion}.tgz`;
  return getPlatformUrlPrefix(hostOS) + cdsFile;
}

function getSDKRoot(): string {
  if (process.env.SDKROOT) return process.env.SDKROOT;
  const output = cp.execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
  return output.toString().trim();
}

export async function getClangEnvironmentVars(electronVersion: string, targetArch: string): Promise<{ env: Record<string, string>; args: string[] }> {
  const clangDownloadDir = await downloadClangVersion(electronVersion);

  const clangDir = path.resolve(clangDownloadDir, 'bin');
  const clangArgs: string[] = [];
  if (process.platform === 'darwin') {
    clangArgs.push('-isysroot', getSDKRoot());
  }

  const gypArgs = [];
  if (process.platform === 'win32') {
    console.log(fs.readdirSync(clangDir));
    gypArgs.push(`/p:CLToolExe=clang-cl.exe`, `/p:CLToolPath=${clangDir}`);
  }

  if (process.platform === 'linux') {
    const sysrootPath = await downloadLinuxSysroot(electronVersion, targetArch);
    clangArgs.push('--sysroot', sysrootPath);

    const cc = `"${path.resolve(clangDir, 'clang')}" ${clangArgs.join(' ')}`
    const cxx = `"${path.resolve(clangDir, 'clang++')}" ${clangArgs.join(' ')}`

    // on Electron 13 or higher, build native modules with Electron's libc++ libraries
    if (parseInt(electronVersion.split('.')[0]) >= 13) {
      const libcxxObjects = await downloadLibcxxObjects(electronVersion, targetArch)
      const libcxxHeadersDownloadDir = await downloadLibcxxHeaders(electronVersion, 'libc++')
      const libcxxabiHeadersDownloadDir = await downloadLibcxxHeaders(electronVersion, 'libc++abi')

      const libcxxHeaders = path.resolve(libcxxHeadersDownloadDir, 'include')
      const libcxxabiHeaders = path.resolve(libcxxabiHeadersDownloadDir, 'include')

      const cxxflags = [
        '-nostdinc++',
        '-D_LIBCPP_HAS_NO_VENDOR_AVAILABILITY_ANNOTATIONS',
        `-isystem"${libcxxHeaders}"`,
        `-isystem"${libcxxabiHeaders}"`,
        '-fPIC'
      ].join(' ');
    
      const ldflags = [
        '-stdlib=libc++',
        '-fuse-ld=lld',
        `-L"${libcxxObjects}"`,
        '-lc++abi'
      ].join(' ');
  
      return {
        env: {
          CC: cc,
          CXX: cxx,
          CFLAGS: cxxflags,
          CXXFLAGS: cxxflags,
          LDFLAGS: ldflags,
        },
        args: gypArgs,
      }
    }
  }

  return {
    env: {
      CC: `"${path.resolve(clangDir, 'clang')}" ${clangArgs.join(' ')}`,
      CXX: `"${path.resolve(clangDir, 'clang++')}" ${clangArgs.join(' ')}`,
    },
    args: gypArgs,
  }
}

function clangVersionFromRevision(update: string): string | null {
  const regex = /CLANG_REVISION = '([^']+)'\nCLANG_SUB_REVISION = (\d+)\n/g;
  const clangVersionMatch = regex.exec(update);
  if (!clangVersionMatch) return null;
  const [,clangVersion, clangSubRevision] = clangVersionMatch;
  return `${clangVersion}-${clangSubRevision}`;
}

function clangVersionFromSVN(update: string): string | null {
  const regex = /CLANG_REVISION = '([^']+)'\nCLANG_SVN_REVISION = '([^']+)'\nCLANG_SUB_REVISION = (\d+)\n/g;
  const clangVersionMatch = regex.exec(update);
  if (!clangVersionMatch) return null;
  const [,clangVersion, clangSvn, clangSubRevision] = clangVersionMatch;
  return `${clangSvn}-${clangVersion.substr(0, 8)}-${clangSubRevision}`;
}

async function downloadClangVersion(electronVersion: string) {
  d('fetching clang for Electron:', electronVersion);
  const clangDirPath = path.resolve(ELECTRON_GYP_DIR, `${electronVersion}-clang`);
  if (await fs.pathExists(path.resolve(clangDirPath, 'bin', 'clang'))) return clangDirPath;
  if (!await fs.pathExists(ELECTRON_GYP_DIR)) await fs.mkdirp(ELECTRON_GYP_DIR);

  const electronDeps = await fetch(`https://raw.githubusercontent.com/electron/electron/v${electronVersion}/DEPS`, 'text');
  const chromiumRevisionExtractor = /'chromium_version':\n\s+'([^']+)/g;
  const chromiumRevisionMatch = chromiumRevisionExtractor.exec(electronDeps);
  if (!chromiumRevisionMatch) throw new Error('Failed to determine Chromium revision for given Electron version');
  const chromiumRevision = chromiumRevisionMatch[1];
  d('fetching clang for Chromium:', chromiumRevision)

  const base64ClangUpdate = await fetch(`https://chromium.googlesource.com/chromium/src.git/+/${chromiumRevision}/tools/clang/scripts/update.py?format=TEXT`, 'text');
  const clangUpdate = Buffer.from(base64ClangUpdate, 'base64').toString('utf8');

  const clangVersionString = clangVersionFromRevision(clangUpdate) || clangVersionFromSVN(clangUpdate);
  if (!clangVersionString) throw new Error('Failed to determine Clang revision from Electron version');
  d('fetching clang:', clangVersionString);

  const clangDownloadURL = getClangDownloadURL('clang', clangVersionString, process.platform);
  
  const contents = await fetch(clangDownloadURL, 'buffer');
  d('deflating clang');
  zlib.deflateSync(contents);
  const tarPath = path.resolve(ELECTRON_GYP_DIR, `${electronVersion}-clang.tar`);
  if (await fs.pathExists(tarPath)) await fs.remove(tarPath)
  await fs.writeFile(tarPath, Buffer.from(contents));
  await fs.mkdirp(clangDirPath);
  d('tar running on clang');
  await tar.x({
    file: tarPath,
    cwd: clangDirPath,
  });
  await fs.remove(tarPath);
  d('cleaning up clang tar file');
  return clangDirPath;
}
