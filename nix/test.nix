# NixOS VM test for nix/module.nix. Run: nix build .#checks.x86_64-linux.module
{ testers, module }:
testers.runNixOSTest {
  name = "ledger";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ module ];
      environment.systemPackages = [ pkgs.curl ];
      virtualisation.memorySize = 768;

      services.ledger = {
        enable = true;
        requireDatabase = true;
        settings = {
          server.listen = "127.0.0.1:8091";
          # ledger refuses to start with AI on and no provider key, so a
          # healthy start on 8091 proves both wires: the TOML is read (the
          # port) and the env file is read (the key).
          ai = {
            enabled = true;
            provider = "typesafe";
          };
        };
        environmentFile = pkgs.writeText "ledger.env" ''
          LEDGER_TYPESAFE_API_KEY=test-only
        '';
      };
    };

  testScript = ''
    def backups():
        return int(machine.succeed("ls /var/lib/ledger/backups | wc -l").strip())

    machine.wait_for_unit("multi-user.target")

    with subtest("requireDatabase holds the unit back"):
        machine.succeed("test \"$(stat -c '%a %U' /var/lib/ledger)\" = '700 ledger'")
        machine.succeed("test \"$(systemctl show -p ConditionResult --value ledger)\" = no")
        machine.fail("curl -sf http://127.0.0.1:8091/api/health")

    with subtest("a copied-in database lets it start, with TOML and env file applied"):
        machine.succeed("install -o ledger -g ledger -m 0600 /dev/null /var/lib/ledger/ledger.db")
        machine.succeed("systemctl start ledger")
        machine.wait_for_open_port(8091, timeout=180)
        machine.succeed("curl -sf http://127.0.0.1:8091/api/health | grep -q '\"db\":\"ok\"'")
        # The file was empty: a fresh install, nothing to keep.
        machine.succeed("test ! -e /var/lib/ledger/backups || test -z \"$(ls /var/lib/ledger/backups)\"")

    with subtest("one backup per build, however often it restarts"):
        machine.succeed("systemctl restart ledger")
        machine.wait_for_open_port(8091, timeout=180)
        assert backups() == 1, f"want 1 backup after the first real start, got {backups()}"
        machine.succeed("test \"$(stat -c %a /var/lib/ledger/backups)\" = 700")
        first = machine.succeed("stat -c %i /var/lib/ledger/backups/before-*.db").strip()
        machine.succeed("systemctl restart ledger")
        machine.wait_for_open_port(8091, timeout=180)
        assert backups() == 1, f"a restart of the same build must not add a backup, got {backups()}"
        # Not taken again either: a crash loop must not overwrite the copy
        # from before this build first touched the database.
        again = machine.succeed("stat -c %i /var/lib/ledger/backups/before-*.db").strip()
        assert first == again, f"the backup was rewritten (inode {first} -> {again})"

    with subtest("keeps the newest five"):
        real = machine.succeed("ls /var/lib/ledger/backups").strip()
        for n in range(1, 7):
            machine.succeed(
                f"install -o ledger -g ledger -m 0600 /dev/null /var/lib/ledger/backups/before-old{n}.db"
                f" && touch -d 2020-01-0{n} /var/lib/ledger/backups/before-old{n}.db"
            )
        machine.succeed("systemctl restart ledger")
        machine.wait_for_open_port(8091, timeout=180)
        assert backups() == 5, f"want 5 backups kept, got {backups()}"
        machine.succeed(f"test -e /var/lib/ledger/backups/{real}")
  '';
}
