export declare const START1: number;
export declare const START2: number;
export declare const MAX_FRAME: number;
export declare function frame(payload: Uint8Array): Uint8Array;
export declare class Deframer {
  constructor(onFrame: (frame: Uint8Array) => void, onLog?: (line: string) => void);
  feed(chunk: Uint8Array): void;
}
