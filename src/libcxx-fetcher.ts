import * as debug from 'debug';
import * as extract from 'extract-zip';
import * as fs from 'fs-extra';
import * as path from 'path';
import { downloadArtifact } from '@electron/get';
import { ELECTRON_GYP_DIR } from './constants';

const d = debug('electron-rebuild');

export async function downloadLibcxxHeaders(electronVersion: string, name: string): Promise<string> {
  const lib_name = name.replace(/\+/g, 'x');
  const headersDirPath = path.resolve(ELECTRON_GYP_DIR, `${electronVersion}-${lib_name}_headers`);
  if (await fs.pathExists(path.resolve(headersDirPath, 'include'))) return headersDirPath;
  if (!await fs.pathExists(ELECTRON_GYP_DIR)) await fs.mkdirp(ELECTRON_GYP_DIR);

  d(`downloading ${lib_name}_headers`);
  const headers = await downloadArtifact({
    version: electronVersion,
    isGeneric: true,
    artifactName: `${lib_name}_headers.zip`,
  });

  d(`unpacking ${lib_name}_headers from ${headers}`);
  await extract(headers, { dir: headersDirPath });
  return headersDirPath;
}

export async function downloadLibcxxObjects(electronVersion: string, targetArch: string): Promise<string> {
  const libcxxObjectsDirPath = path.resolve(ELECTRON_GYP_DIR, 'libcxx-objects');
  if (await fs.pathExists(path.resolve(libcxxObjectsDirPath, 'libc++.a'))) return libcxxObjectsDirPath;
  if (!await fs.pathExists(ELECTRON_GYP_DIR)) await fs.mkdirp(ELECTRON_GYP_DIR);

  d(`downloading libcxx-objects-linux-${targetArch}`);
  const objects = await downloadArtifact({
    version: electronVersion,
    platform: 'linux',
    artifactName: 'libcxx-objects',
    arch: targetArch,
  });

  d(`unpacking libcxx-objects from ${objects}`);
  await extract(objects, { dir: libcxxObjectsDirPath });
  return libcxxObjectsDirPath;
}
