import type { Entity } from "./baseTypes";
export function assertLocalVersion(expected: Entity | undefined, actual: Entity | undefined) {
  const isFolder = (entity: Entity) => (entity.key ?? entity.keyRaw).endsWith("/");
  if ((!expected !== !actual) || (expected && actual &&
      (isFolder(expected) !== isFolder(actual) || (!isFolder(expected) &&
       (expected.sizeRaw !== actual.sizeRaw || expected.mtimeCli !== actual.mtimeCli))))) {
    throw Object.assign(new Error("Local file changed after scan"), {code: "plan_changed"});
  }
}
