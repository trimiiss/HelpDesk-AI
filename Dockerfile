# One recipe, one image per service, each holding only that service's code and
# dependencies. Build from the repo root:
#
#   docker build --build-arg SERVICE_DIR=services/call-gateway --target service -t helpdesk/call-gateway .
#
# ingest-job adds the knowledge folder, so it builds with --target ingest-job.

ARG SERVICE_DIR=services/call-gateway

FROM node:24-slim AS build
ARG SERVICE_DIR
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY --parents packages/*/package.json services/*/package.json tools/*/package.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY packages packages
COPY ${SERVICE_DIR} ${SERVICE_DIR}
RUN npx tsc -b ${SERVICE_DIR}
# Keep only compiled output. A stable entry point lets every image share one CMD.
RUN mkdir /out \
  && for dir in packages/* ${SERVICE_DIR}; do \
       if [ -d "$dir/dist" ]; then \
         mkdir -p "/out/$dir" && cp -r "$dir/package.json" "$dir/dist" "/out/$dir/"; \
       fi; \
     done \
  && echo "import './${SERVICE_DIR}/dist/index.js';" > /out/main.mjs \
  && find /out -name '*.map' -delete -o -name '*.d.ts' -delete -o -name '*.tsbuildinfo' -delete

FROM node:24-slim AS production-deps
ARG SERVICE_DIR
WORKDIR /app
COPY package.json package-lock.json ./
COPY --parents packages/*/package.json services/*/package.json tools/*/package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --ignore-scripts --omit=dev --workspace "./${SERVICE_DIR}"

# Distroless has no shell or package manager, which leaves little to attack and
# little for a vulnerability scanner to flag.
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS service
WORKDIR /app
ENV NODE_ENV=production
# The whole tree, not just the root node_modules: npm nests a package under its
# workspace when two versions of it clash.
COPY --from=production-deps /app ./
COPY --from=build /out ./
COPY config config
COPY db db
USER 65532:65532
CMD ["main.mjs"]

FROM service AS ingest-job
COPY knowledge /knowledge
