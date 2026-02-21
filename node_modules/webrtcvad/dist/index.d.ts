/// <reference types="node" />
export default class VAD {
    private sampleRate;
    private instance;
    constructor(sampleRate?: number, level?: number);
    private valid;
    process(audio: Buffer): boolean;
}
