#!/usr/bin/env bash
# UploadContainer.sh — PilotSwarm EV2 shell extension
#
# Official Microsoft EV2 pattern (mirrors postgresql-fleet-manager):
# downloads the image tarball from EV2's per-rollout SAS URL (supplied
# by EV2 via the `reference` mechanism on a service-artifact path) and
# pushes it to the target ACR using `oras`. No local docker daemon is
# used on either side — tarballs travel inside the EV2 service artifact
# rather than via a holding ACR.
#
# Required env vars (wired from UploadContainer.Linux.Rollout.json +
# scopeBinding.json):
#   DEPLOYMENT_ACR_NAME      Bare ACR name (not the FQDN) of the target
#                            per-region ACR.
#   TARBALL_IMAGE_FILE_SAS   SAS URL that EV2 mints for the image file
#                            inside the uploaded service artifact
#                            (resolved from the rollout-params
#                            reference.path = e.g.
#                            "ContainerImages/<image>.tar.gz").
#   DESTINATION_FILE_NAME    Local filename to wget into. Must end in
#                            .tar or .tar.gz (gz is decompressed first).
#   IMAGE_NAME               Target image repository name inside the ACR
#                            (e.g. pilotswarm-worker).
#   TAG_NAME                 Target image tag (typically $buildVersion()
#                            from EV2, i.e. ArtifactsVersion).
set -euo pipefail

for v in DEPLOYMENT_ACR_NAME TARBALL_IMAGE_FILE_SAS DESTINATION_FILE_NAME IMAGE_NAME TAG_NAME; do
  if [ -z "${!v+x}" ]; then
    echo "$v is unset, unable to continue" >&2
    exit 1
  fi
done

echo "Logging in with managed identity"
az login --identity >/dev/null

oras version

TMP_FOLDER="$(mktemp -d)"
cd "$TMP_FOLDER"

echo "Downloading docker tarball image from EV2-issued SAS URL"
wget -q -O "$DESTINATION_FILE_NAME" "$TARBALL_IMAGE_FILE_SAS"

echo "Requesting ACR access token for $DEPLOYMENT_ACR_NAME"
# Tolerate callers passing either the bare ACR name or the full login
# server FQDN (e.g. foo.azurecr.io). `az acr login --name` requires the
# bare name, and so does the oras login host below (we re-add the
# suffix explicitly).
DEPLOYMENT_ACR_NAME="${DEPLOYMENT_ACR_NAME%%.azurecr.io}"
USERNAME="00000000-0000-0000-0000-000000000000"
PASSWORD="$(az acr login --name "$DEPLOYMENT_ACR_NAME" --expose-token --output tsv --query accessToken)"

echo "Logging in to ACR with oras"
oras login "$DEPLOYMENT_ACR_NAME.azurecr.io" --username "$USERNAME" --password-stdin <<< "$PASSWORD"

DEST_IMAGE_FULL_NAME="$DEPLOYMENT_ACR_NAME.azurecr.io/$IMAGE_NAME:$TAG_NAME"

if [[ "$DESTINATION_FILE_NAME" == *.gz ]]; then
  echo "Decompressing $DESTINATION_FILE_NAME"
  gunzip "$DESTINATION_FILE_NAME"
  DESTINATION_FILE_NAME="${DESTINATION_FILE_NAME%.gz}"
fi

echo "Pushing $DESTINATION_FILE_NAME -> $DEST_IMAGE_FULL_NAME"
oras cp --recursive --from-oci-layout "$DESTINATION_FILE_NAME:$TAG_NAME" "$DEST_IMAGE_FULL_NAME"
echo "Image pushed successfully."