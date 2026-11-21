// 把 Vditor 的静态资源（lute、语言包、代码高亮、公式等）复制到 public，离线可用
import { cpSync, existsSync, rmSync } from "node:fs";
const src = "node_modules/vditor/dist";
const dst = "public/vditor/dist";
if (existsSync(src)) {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log("vditor assets copied to", dst);
}
