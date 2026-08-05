import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, here), "utf8");

describe("production composition reachability", () => {
  test("Root owns the provider and Navigation consumes its live client", () => {
    const root = read("Root.tsx");
    const navigation = read("Navigation.tsx");
    expect(root).toContain("<RuntimeProvider>");
    expect(navigation).toContain("useRuntime()");
    expect(navigation).toContain("backend: runtime.client");
    expect(navigation).not.toContain("deviceSignInDeps()");
    expect(navigation).not.toContain("backend: null");
  });

  test("native construction is centralized in runtime.native", () => {
    const native = read("runtime.native.ts");
    const runtime = read("runtime.ts");
    expect(native).toContain("openDriver: expoDriver");
    expect(native).toContain("secrets: keychainSecretStore()");
    expect(runtime).toContain("new Client(");
    expect(runtime).toContain("new SyncEngine(");
    expect(runtime).toContain("new Outbox(");
  });
});
