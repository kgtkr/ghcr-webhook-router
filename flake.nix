{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    dream2nix.url = "github:nix-community/dream2nix";
    dream2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      imports = [
        ./image.nix
      ];
      perSystem =
        {
          pkgs,
          ...
        }:
        let
          lib = pkgs.lib;
          nodejs = pkgs.nodejs_24;
          ghcrWebhookRouter = inputs.dream2nix.lib.evalModules {
            packageSets.nixpkgs = pkgs;
            modules = [
              inputs.dream2nix.modules.dream2nix.nodejs-package-lock-v3
              inputs.dream2nix.modules.dream2nix.nodejs-granular-v3
              {
                name = "ghcr-webhook-router";
                version = "0.0.0";
                mkDerivation = {
                  src = ./.;
                  preInstallPhases = lib.mkForce [ ];
                  installPhase = ''
                    runHook preInstall

                    mkdir -p $out/lib/ghcr-webhook-router
                    cp -a dist/index.mjs $out/lib/ghcr-webhook-router/index.mjs

                    mkdir -p $out/bin
                    makeWrapper ${nodejs}/bin/node $out/bin/ghcr-webhook-router \
                      --chdir $out/lib/ghcr-webhook-router \
                      --add-flags $out/lib/ghcr-webhook-router/index.mjs \
                      --set-default PORT 3000 \
                      --set-default NODE_ENV production

                    runHook postInstall
                  '';
                  passthru = {
                    meta = {
                      mainProgram = "ghcr-webhook-router";
                    };
                  };
                };
                deps =
                  { nixpkgs, ... }:
                  {
                    inherit (nixpkgs) fetchFromGitHub stdenv;
                    inherit nodejs;
                  };
                nodejs-package-lock-v3 = {
                  packageLockFile = ./package-lock.json;
                };
              }
            ];
          };
        in
        {
          packages = {
            ghcr-webhook-router = ghcrWebhookRouter;
            default = ghcrWebhookRouter;
          };

          devShells.default = pkgs.mkShell {
            buildInputs = [
              nodejs
              pkgs.skopeo
              pkgs.manifest-tool
            ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
          formatter = pkgs.nixfmt-tree;
        };
    };
}
