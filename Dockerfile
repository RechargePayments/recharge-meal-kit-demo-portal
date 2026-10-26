# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=18.20.4

FROM node:${NODE_VERSION}-alpine AS deps

# eMudhra intermediate CA compromise (https://emudhra.we-have-a-problem.com/): require the patched ca-certificates; npm ignore the app's certifi, so point them at the system bundle
RUN apk add --no-cache 'ca-certificates>=20261020-r0'
ENV NPM_CONFIG_CAFILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:${NODE_VERSION}-alpine AS builder

# eMudhra intermediate CA compromise (https://emudhra.we-have-a-problem.com/): require the patched ca-certificates; npm ignore the app's certifi, so point them at the system bundle
RUN apk add --no-cache 'ca-certificates>=20261020-r0'
ENV NPM_CONFIG_CAFILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-alpine AS runner

# eMudhra intermediate CA compromise (https://emudhra.we-have-a-problem.com/): require the patched ca-certificates; npm ignore the app's certifi, so point them at the system bundle
RUN apk add --no-cache 'ca-certificates>=20261020-r0'
ENV NPM_CONFIG_CAFILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/build ./build
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/data ./data
USER app
EXPOSE 3000
CMD ["npm", "start"]
