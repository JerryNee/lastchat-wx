declare module "qrcode-terminal" {
  interface Options { small?: boolean }
  function generate(text: string, opts?: Options, cb?: (q: string) => void): void;
  const _default: { generate: typeof generate };
  export default _default;
  export { generate };
}
