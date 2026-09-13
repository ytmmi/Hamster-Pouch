/**
 * M4：评分类型。
 */

export interface RatingSetArgs {
  repoId: string;
  fileId: string;
  rating: number;
}

export interface RatingGetArgs {
  repoId: string;
  fileId: string;
}
