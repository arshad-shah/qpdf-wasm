export interface QpdfModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, bytes: Uint8Array): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
    chdir(path: string): void;
  };
  callMain(args: string[]): number;
}
export default function createQpdf(options: {
  thisProgram: string;
  noInitialRun: boolean;
  locateFile?: (path: string, prefix: string) => string;
  instantiateWasm?: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => WebAssembly.Exports;
  print: (line: string) => void;
  printErr: (line: string) => void;
}): Promise<QpdfModule>;
