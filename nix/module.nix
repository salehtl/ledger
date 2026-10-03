# NixOS module for ledger. Import it through the flake's nixosModules.default,
# which also sets services.ledger.package.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.ledger;
  settingsFormat = pkgs.formats.toml { };
  configFile = settingsFormat.generate "ledger.toml" cfg.settings;
  stateDir = "/var/lib/ledger";

  # A copy of the database before each new build first opens it. Deploys can
  # land unattended (a nightly upgrade), and a schema migration is one-way.
  backupBeforeNewBuild = pkgs.writeShellScript "ledger-backup-before-new-build" ''
    set -eu
    db=${stateDir}/ledger.db
    dir=${stateDir}/backups
    # A missing or empty file is a fresh install: nothing to keep.
    [ -s "$db" ] || exit 0
    mkdir -p "$dir"
    out="$dir/before-${baseNameOf (toString cfg.package)}.db"
    # Once per build, so a crash loop cannot rotate out the copy taken
    # before this build first touched the database.
    if [ ! -e "$out" ]; then
      ${lib.getBin pkgs.sqlite}/bin/sqlite3 "$db" ".backup '$out.part'"
      mv "$out.part" "$out"
    fi
    ls -1t "$dir"/before-*.db | tail -n +${toString (cfg.backupsToKeep + 1)} | xargs -r rm -f --
  '';
in
{
  options.services.ledger = {
    enable = lib.mkEnableOption "ledger, the self-hosted budgeting PWA";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The ledger package. The flake's nixosModules.default sets it.";
    };

    settings = lib.mkOption {
      description = ''
        config.toml as Nix. config.example.toml lists every key. Never put a
        secret here: it lands in the world-readable Nix store. Secrets come
        from environmentFile.
      '';
      default = { };
      type = lib.types.submodule {
        freeformType = settingsFormat.type;
        options.server = {
          listen = lib.mkOption {
            type = lib.types.str;
            default = "127.0.0.1:8080";
            description = "The address the HTTP server binds. Keep it on loopback.";
          };
          data_dir = lib.mkOption {
            type = lib.types.str;
            default = stateDir;
            readOnly = true;
            description = "The unit's StateDirectory. Fixed.";
          };
        };
      };
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        A systemd EnvironmentFile with the LEDGER_* secrets
        (LEDGER_IMAP_APP_PASSWORD, LEDGER_TYPESAFE_API_KEY, LEDGER_VAPID_*).
        Give a path outside the Nix store, such as a sops-nix secret.
      '';
    };

    requireDatabase = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Start only when ${stateDir}/ledger.db exists. Set it on a host that
        receives a copied database: a fresh one would ingest the whole
        mailbox again and send each email through the AI check.
      '';
    };

    backupsToKeep = lib.mkOption {
      type = lib.types.ints.positive;
      default = 5;
      description = "How many before-build database copies to keep in ${stateDir}/backups.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.ledger = {
      isSystemUser = true;
      group = "ledger";
      home = stateDir;
    };
    users.groups.ledger = { };

    # The directory exists before the first start, so a database can be
    # copied in while requireDatabase holds the unit back.
    systemd.tmpfiles.rules = [ "d ${stateDir} 0700 ledger ledger -" ];

    systemd.services.ledger = {
      description = "ledger budgeting service";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      unitConfig.ConditionPathExists = lib.mkIf cfg.requireDatabase "${stateDir}/ledger.db";

      serviceConfig = {
        ExecStartPre = backupBeforeNewBuild;
        ExecStart = "${lib.getExe cfg.package} -config ${configFile}";
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        User = "ledger";
        Group = "ledger";
        Restart = "on-failure";
        RestartSec = 5;
        StateDirectory = "ledger";
        # Financial data: owner-only.
        StateDirectoryMode = "0700";
        UMask = "0077";
        # Caps a leak. Peak RSS on dinosaur was about 110M.
        MemoryMax = "384M";

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
      };
    };
  };
}
