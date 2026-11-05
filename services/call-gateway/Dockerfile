# Build from the repo root:
#   docker build -f services/call-gateway/Dockerfile -t helpdesk/call-gateway .

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/call-gateway/package.json services/call-gateway/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY services/call-gateway services/call-gateway
RUN npx tsc -b services/call-gateway

FROM node:24-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/call-gateway/package.json services/call-gateway/
RUN npm ci --omit=dev --ignore-scripts

# Distroless has no shell or package manager, which leaves little to attack
# and little for a vulnerability scanner to flag.
FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-deps /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/call-gateway/package.json services/call-gateway/package.json
COPY --from=build /app/services/call-gateway/dist services/call-gateway/dist
COPY config config
EXPOSE 8080
CMD ["services/call-gateway/dist/index.js"]
