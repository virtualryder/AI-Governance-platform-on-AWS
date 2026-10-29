#!/usr/bin/env bash
# Build the ARM64 agent image (AgentCore Runtime is ARM64), ensure the ECR repo exists with image
# scanning + immutable tags, push it, and resolve the immutable DIGEST reference to deploy.
#
# Requires: a running Docker daemon with buildx (QEMU cross-builds arm64 on x86), and an explicitly
# named AWS profile + region (no silent default-profile fallback — avoids pushing to the wrong account).
#
# Usage:
#   ./build-image.sh --profile <aws-profile> --region us-east-1 --repo govai-citizen-311 [--tag v1]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE=""; REGION=""; REPO="govai-citizen-311"; TAG="v1"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
if [[ -z "$PROFILE" || -z "$REGION" ]]; then
  echo "error: --profile and --region are required (no default-profile fallback)." >&2
  exit 2
fi
AWS=(aws --profile "$PROFILE" --region "$REGION")
ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

# Ensure the repo exists with scan-on-push + immutable tags (no silent assume-exists).
if ! "${AWS[@]}" ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1; then
  echo "Creating ECR repo ${REPO} (scan-on-push, IMMUTABLE tags, AES256)..."
  "${AWS[@]}" ecr create-repository --repository-name "$REPO" \
    --image-scanning-configuration scanOnPush=true \
    --image-tag-mutability IMMUTABLE \
    --encryption-configuration encryptionType=AES256 >/dev/null
fi

"${AWS[@]}" ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"

URI="${REGISTRY}/${REPO}:${TAG}"
docker buildx build --platform linux/arm64 -t "$URI" --push "$HERE"

# Resolve the immutable digest — deploy by digest, never a mutable tag.
DIGEST="$("${AWS[@]}" ecr describe-images --repository-name "$REPO" --image-ids imageTag="$TAG" \
  --query 'imageDetails[0].imageDigest' --output text)"
echo "IMAGE_TAG_URI=${URI}"
echo "IMAGE_DIGEST_URI=${REGISTRY}/${REPO}@${DIGEST}"
echo ""
echo "Set agentcore.runtimeImageUri to the DIGEST reference above (immutable), then deploy."
