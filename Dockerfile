# syntax=docker/dockerfile:1
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev cmake make perl clang ca-certificates
WORKDIR /src/backend
COPY backend/Cargo.toml backend/Cargo.lock ./
# Build the dependencies once, so code changes don't rebuild them.
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src
COPY static /src/static
COPY backend ./
RUN touch src/main.rs && cargo build --release --locked \
 && mkdir -p /out/data && cp target/release/pl8inf /out/pl8inf

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/pl8inf /pl8inf
COPY --from=build --chown=10001:10001 /out/data /data
ENV HOST=0.0.0.0 \
    PORT=8790 \
    PL8_DB=/data/pl8list.db \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER 10001:10001
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["/pl8inf", "--healthcheck"]
ENTRYPOINT ["/pl8inf"]
