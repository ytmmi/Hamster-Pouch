/**
 * M4：色彩参考类型（仅图片，D18）。
 */

export interface ColorGetArgs {
  repoId: string;
  fileId: string;
}

export interface ColorSetArgs {
  repoId: string;
  fileId: string;
  colorJson: string;
}

export interface ColorExtractArgs {
  repoId: string;
  fileId: string;
}
