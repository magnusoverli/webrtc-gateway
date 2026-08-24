# Offline Deployment

This bundle contains the Linux AMD64 Gateway and MediaMTX images required by the Compose stack. The images were built or pulled by CI for the commit recorded in `GATEWAY_COMMIT`.

The target server needs Linux on x86-64, Docker Engine, and the Docker Compose plugin. It does not need internet access.

The latest bundle and its checksum can be downloaded without authentication from:

```text
https://github.com/magnusoverli/webrtc-gateway/releases/download/main-latest/webrtc-gateway-offline-linux-amd64.tar
https://github.com/magnusoverli/webrtc-gateway/releases/download/main-latest/webrtc-gateway-offline-linux-amd64.tar.sha256
```

## Install Or Upgrade

Copy the complete extracted bundle to the target server, enter its directory, and run:

```sh
sha256sum --check SHA256SUMS
docker load --input images-linux-amd64.tar.gz
docker compose up -d --no-build --pull never
docker compose ps
```

The fixed Compose project name preserves the existing `webrtc-gateway_gateway-state` volume during upgrades. Keep a previous bundle if you need to load its images and roll back.

Do not run `docker compose down --volumes` unless the channel database and global settings should also be deleted.
