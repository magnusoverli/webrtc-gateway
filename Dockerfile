FROM node:24-alpine AS web-build

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS go-build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY --from=web-build /src/web/dist/ ./internal/webui/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gateway ./cmd/gateway

FROM alpine:3.23 AS srt-build

ARG SRT_VERSION=1.5.6
ARG SRT_COMMIT=c63c311e88aa55e430e3b7d94b89d790994f88c4
ARG SRT_SHA256=49db3bf47c55037bee2b749ba977c3002873f42afcacba5577a318b3cd6f09c4

RUN apk add --no-cache build-base cmake linux-headers openssl-dev \
    && wget -qO /tmp/srt.tar.gz \
        "https://codeload.github.com/Haivision/srt/tar.gz/${SRT_COMMIT}" \
    && echo "${SRT_SHA256}  /tmp/srt.tar.gz" | sha256sum -c - \
    && mkdir -p /tmp/srt /tmp/pkg /out \
    && tar -xzf /tmp/srt.tar.gz -C /tmp/srt --strip-components=1 \
    && cmake -S /tmp/srt -B /tmp/srt/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DUSE_ENCLIB=openssl-evp \
        -DENABLE_SHARED=ON \
        -DENABLE_STATIC=OFF \
        -DENABLE_APPS=ON \
        -DENABLE_TESTING=OFF \
        -DENABLE_UNITTESTS=OFF \
    && cmake --build /tmp/srt/build --parallel \
    && DESTDIR=/tmp/pkg cmake --install /tmp/srt/build --strip \
    && rm -rf \
        /tmp/pkg/usr/include \
        /tmp/pkg/usr/lib/pkgconfig \
        /tmp/pkg/usr/lib/libsrt.so \
        /tmp/pkg/usr/bin/srt-ffplay \
        /tmp/pkg/usr/bin/srt-file-transmit \
        /tmp/pkg/usr/bin/srt-tunnel \
    && LD_LIBRARY_PATH=/tmp/pkg/usr/lib \
        /tmp/pkg/usr/bin/srt-live-transmit -version 2>&1 \
        | grep -Fq "SRT Library version: ${SRT_VERSION}" \
    && apk mkpkg \
        --files /tmp/pkg \
        --output /out/libsrt.apk \
        --info "name:libsrt" \
        --info "version:${SRT_VERSION}-r0" \
        --info "arch:$(apk --print-arch)" \
        --info "description:Secure Reliable Transport (SRT) and srt-live-transmit" \
        --info "license:MPL-2.0" \
        --info "origin:libsrt" \
        --info "url:https://github.com/Haivision/srt" \
        --info "depends:musl libcrypto3 libgcc libstdc++" \
        --info "provides:so:libsrt.so.1.5 cmd:srt-live-transmit"

FROM alpine:3.23

COPY --from=srt-build /out/libsrt.apk /tmp/libsrt.apk
RUN apk add --no-cache --allow-untrusted /tmp/libsrt.apk ffmpeg \
    && rm /tmp/libsrt.apk \
    && addgroup -S gateway && adduser -S -G gateway gateway \
    && mkdir -p /var/lib/webrtc-gateway \
    && chown gateway:gateway /var/lib/webrtc-gateway
COPY --from=go-build /out/gateway /usr/local/bin/gateway

USER gateway
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/gateway"]
