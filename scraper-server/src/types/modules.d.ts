declare module "puppeteer-extra" {
  import { Browser, LaunchOptions } from "puppeteer-core";
  const puppeteerExtra: {
    use(plugin: any): void;
    launch(options?: LaunchOptions): Promise<Browser>;
  };
  export default puppeteerExtra;
}

declare module "puppeteer-extra-plugin-stealth" {
  const StealthPlugin: () => any;
  export default StealthPlugin;
}

declare module "uuid" {
  export function v4(): string;
}