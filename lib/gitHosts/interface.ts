export interface GitHostAdapter {
  pushBranch(remote: string, branch: string): void;
  createPr(title: string, branch: string, body: string): string; // returns PR ref (URL or number)
  checkPrStatus(prRef: string): 'open' | 'merged' | 'closed';
  waitForCi(prRef: string): 'passing' | 'failing'; // blocks until CI resolves
  mergePr(prRef: string): void;
  submitReview(prRef: string, body: string, approve: boolean): void;
  getPrBody(prRef: string): string;
  getPrDiff(prRef: string): string;
}
