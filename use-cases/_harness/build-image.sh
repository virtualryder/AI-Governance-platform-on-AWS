#!/usr/bin/env bash
# Build the ARM64 agent image (AgentCore Runtime is ARM64) and push to ECR.
# Usage: AWS_PROFILE=default REPO=govai-citizen-311 TAG=latest bash build-image.sh
# Requires a running Docker daemon with buildx (QEMU emulation cross-builds arm64 on x86).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
REPO="${REPO:-govai-citizen-311}"
TAG="${TAG:-latest}"
ACCOUNT="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"
URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

aws ecr get-login-password --region "$REGION" --profile "$PROFILE" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

docker buildx build --platform linux/arm64 -t "$URI" --push "$HERE"
echo "IMAGE_URI=$URI"
