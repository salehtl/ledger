{
  description = "ledger: a private, self-hosted budgeting PWA";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      # The commit shows in the store path, so `readlink /proc/<pid>/exe`
      # names the build that is running.
      rev = self.shortRev or self.dirtyShortRev or "dirty";
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.callPackage ./nix/package.nix { inherit rev; };
      });

      # Built with the host's nixpkgs, so a host that sets
      # `inputs.nixpkgs.follows` gets its own Go toolchain.
      nixosModules.default =
        { lib, pkgs, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.ledger.package = lib.mkDefault (pkgs.callPackage ./nix/package.nix { inherit rev; });
        };

      checks = forAllSystems (pkgs: {
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        module = pkgs.callPackage ./nix/test.nix { module = self.nixosModules.default; };
      });
    };
}
