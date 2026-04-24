#!/bin/bash
set -e

if [ -z ${DEPLOYMENT_ACR_NAME+x} ]; then
  echo "DEPLOYMENT_ACR_NAME is unset, unable to continue"
  exit 1;
fi

if [ -z ${TARBALL_IMAGE_FILE_SAS+x} ]; then
  echo "TARBALL_IMAGE_FILE_SAS is unset, unable to continue"
  exit 1;
fi

if [ -z ${IMAGE_NAME+x} ]; then
  echo "IMAGE_NAME is unset, unable to continue"
  exit 1;
fi

if [ -z ${TAG_NAME+x} ]; then
  echo "TAG_NAME is unset, unable to continue"
  exit 1;
fi

if [ -z ${DESTINATION_FILE_NAME+x} ]; then
  echo "DESTINATION_FILE_NAME is unset, unable to continue"
  exit 1;
fi

echo "Folder Contents"
ls

echo "Login cli using managed identity"
az login --identity

oras version
TMP_FOLDER=$(mktemp -d)
cd $TMP_FOLDER

echo "Downloading docker tarball image from $TARBALL_IMAGE_FILE_SAS."
wget -O $DESTINATION_FILE_NAME $TARBALL_IMAGE_FILE_SAS -q

echo "Getting the ACR acess token."
USERNAME="00000000-0000-0000-0000-000000000000"
PASSWORD=$(az acr login --name $DEPLOYMENT_ACR_NAME --expose-token --output tsv --query accessToken)

echo "Logging in with ORAS."
oras login "$DEPLOYMENT_ACR_NAME.azurecr.io" --username $USERNAME --password-stdin <<< $PASSWORD

DEST_IMAGE_FULL_NAME="$DEPLOYMENT_ACR_NAME.azurecr.io/$IMAGE_NAME:$TAG_NAME"

if [[ "$DESTINATION_FILE_NAME" == *.gz ]]; then
  gunzip $DESTINATION_FILE_NAME
  echo "$DESTINATION_FILE_NAME has been decompressed."

  DESTINATION_FILE_NAME="${DESTINATION_FILE_NAME%.gz}"
  echo "The decompressed file is: $DESTINATION_FILE_NAME"
else
  echo "$DESTINATION_FILE_NAME is not a .gz file."
fi
ls

echo "Pushing file $DESTINATION_FILE_NAME to $DEST_IMAGE_FULL_NAME"
oras cp --recursive --from-oci-layout "$DESTINATION_FILE_NAME:$TAG_NAME" $DEST_IMAGE_FULL_NAME
