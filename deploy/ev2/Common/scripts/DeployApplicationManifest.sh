#!/bin/bash
set -e

if [ -z ${DEPLOYMENT_STORAGE_ACCOUNT_NAME+x} ]; then
  echo "DEPLOYMENT_STORAGE_ACCOUNT_NAME is unset, unable to continue"
  exit 1;
fi

if [ -z ${DEPLOYMENT_STORAGE_CONTAINER_NAME+x} ]; then
  echo "DEPLOYMENT_STORAGE_CONTAINER_NAME is unset, unable to continue"
  exit 1;
fi

if [ -z ${DEPLOYMENT_OVERLAY_PATH+x} ]; then
  echo "DEPLOYMENT_OVERLAY_PATH is unset, unable to continue"
  exit 1;
fi

if [ -z ${APPLICATION_MANIFESTS_SAS+x} ]; then
  echo "APPLICATION_MANIFESTS_SAS is unset, unable to continue"
  exit 1;
fi

if [ -z ${DESTINATION_FILE_NAME+x} ]; then
  echo "DESTINATION_FILE_NAME is unset, unable to continue"
  exit 1;
fi

echo "Folder Contents"
ls

# Resolve the full path to the PowerShell script
PS_SCRIPT_PATH="$(realpath GenerateEnvForEv2.ps1)"

echo "Login cli using managed identity"
az login --identity

TMP_FOLDER=$(mktemp -d)
cd $TMP_FOLDER

# Define the JSON parameters file name
JSON_PARAMETERS_FILE_NAME="DeployApplicationManifest.parameters.json"

echo "Downloading application manifest parameters zip from $APPLICATION_MANIFEST_PARAMETERS_SAS."
wget -O $JSON_PARAMETERS_FILE_NAME $APPLICATION_MANIFEST_PARAMETERS_SAS -q
ls

JSON_PARAMETERS_FILE_PATH="$(realpath $JSON_PARAMETERS_FILE_NAME)"
echo "JSON Parameters File Path: $JSON_PARAMETERS_FILE_PATH"

echo "Downloading application manifest zip from $APPLICATION_MANIFESTS_SAS."
wget -O $DESTINATION_FILE_NAME $APPLICATION_MANIFESTS_SAS -q

if [[ "$DESTINATION_FILE_NAME" == *.zip ]]; then
  # Check if unzip is available, install if missing
  if ! command -v unzip &> /dev/null; then
    echo "unzip not found. Installing..."
    tdnf install -y unzip
    echo "unzip installed successfully."
  fi

  mkdir -p manifests
  unzip $DESTINATION_FILE_NAME -d manifests
  echo "$DESTINATION_FILE_NAME has been unzipped into the 'manifests' directory."
else
  echo "$DESTINATION_FILE_NAME is not a .zip file."
fi

cd manifests
echo "Manifest Folder Contents"
ls -R

echo "Applying Environment Variables"

# Define the .env file paths to update
ENV_FILE_PATHS=(
  "$(realpath $DEPLOYMENT_OVERLAY_PATH/.env)"
)

# Loop through each .env file path and invoke the PowerShell function
for ENV_FILE_PATH in "${ENV_FILE_PATHS[@]}"; do
  echo "Updating environment file: $ENV_FILE_PATH"
  pwsh -NoProfile -Command ". '$PS_SCRIPT_PATH'; Update-EnvFileFromParametersJson -FilePath '$ENV_FILE_PATH' -JsonFilePath '$JSON_PARAMETERS_FILE_PATH';"

  # Check if the PowerShell script executed successfully
  if [ $? -eq 0 ]; then
    echo "Environment file $ENV_FILE_PATH updated successfully."
  else
    echo "Failed to update the environment file $ENV_FILE_PATH."
    exit 1
  fi
done

# echo "Applying Kustomizations"

echo "Upload Manifest Files to the container '$DEPLOYMENT_STORAGE_CONTAINER_NAME' in Storage account '$DEPLOYMENT_STORAGE_ACCOUNT_NAME'"
UPLOAD_SUCCESS=true
if az storage blob upload-batch --auth-mode login --account-name $DEPLOYMENT_STORAGE_ACCOUNT_NAME --destination $DEPLOYMENT_STORAGE_CONTAINER_NAME --source . --overwrite; then
  echo "Manifest files uploaded successfully."
else
  echo "Failed to upload manifest files. Continuing execution."
  UPLOAD_SUCCESS=false
fi

echo "Sleeping for 2 minutes to allow for log upload to complete"
# A work around for log truncation issue in Ev2: https://ev2docs.azure.net/features/service-artifacts/actions/shell-extensions/overview.html?q=Log#faq
# The issue regarding logs truncation / missing logs at the end of the execution is a known Azure Container Instance issue Incident-214316639 Details - IcM (microsofticm.com). 
# The current mitigation, as provided on the ICM, is to add a 2 min sleep at the end of the shell script until the fix is rolled out to all regions by ACI. The associated bug id is 9589108
sleep 120

if [ "$UPLOAD_SUCCESS" = false ]; then
  echo "Exiting with failure due to upload error."
  exit 1
fi