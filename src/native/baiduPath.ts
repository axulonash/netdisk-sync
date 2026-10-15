import { BaiduReadError } from "./baiduRead";
const valid = (path: string) => {
  if (
    typeof path !== "string" ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("//")
  )
    throw new BaiduReadError("invalid_path");
  try {
    encodeURIComponent(path);
  } catch {
    throw new BaiduReadError("invalid_path");
  }
  const value = path.endsWith("/") ? path.slice(0, -1) : path;
  if (
    !value ||
    value
      .split("/")
      .some(
        (part, index) => (!part && index !== 0) || part === "." || part === ".."
      )
  )
    throw new BaiduReadError("invalid_path");
  return value;
};
export const baiduSyncRoot = (root: string): string => {
  const path = valid(root);
  if (!path.startsWith("/")) throw new BaiduReadError("invalid_path");
  return path;
};
export const baiduSyncPath = (root: string, key: string): string => {
  const base = baiduSyncRoot(root);
  const relative = valid(key);
  if (relative.startsWith("/")) throw new BaiduReadError("invalid_path");
  return `${base}/${relative}`;
};
