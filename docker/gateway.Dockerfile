# Multi-stage Dockerfile for Gateway Service
# Stage 1: Build stage (compiles TypeScript to JavaScript)
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching
COPY gateway/package*.json ./

# Install all dependencies (including devDependencies required for tsc compilation)
RUN npm ci

# Copy tsconfig and source code
COPY gateway/tsconfig.json ./
COPY gateway/src ./src

# Compile TypeScript and copy static assets (src/lua -> dist/lua)
RUN npm run build

# Ensure lua scripts directory is present in dist/
RUN cp -r src/lua dist/lua

# Prune devDependencies to keep production image minimal
RUN npm prune --omit=dev

# Stage 2: Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy package manifests, pruned node_modules, and compiled output from builder stage
COPY gateway/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Expose gateway service port
EXPOSE 4000

# Start compiled server
CMD ["node", "dist/index.js"]
