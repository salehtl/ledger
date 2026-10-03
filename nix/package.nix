{
  lib,
  buildGoModule,
  rev ? "dev",
}:
buildGoModule {
  pname = "ledger";
  version = "1.0-${rev}";

  # Only what the Go build reads. internal/web/dist is the committed PWA
  # bundle that Go embeds: the Nix build never runs Node, so build the
  # frontend and commit the dist before the commit a host pins.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../go.mod
      ../go.sum
      ../cmd
      ../internal
    ];
  };

  vendorHash = "sha256-6CWTILMOL2632DZooBFoW6kgzQyxAl+d4E6CRpFjfR0=";
  subPackages = [ "cmd/ledger" ];
  env.CGO_ENABLED = 0;
  ldflags = [
    "-s"
    "-w"
  ];

  # The gate is `go test ./... && cd frontend && bun run test`, run before a
  # push. The Nix build only compiles.
  doCheck = false;

  meta = {
    description = "Private, self-hosted budgeting PWA";
    homepage = "https://github.com/salehtl/ledger";
    mainProgram = "ledger";
    platforms = lib.platforms.linux;
  };
}
