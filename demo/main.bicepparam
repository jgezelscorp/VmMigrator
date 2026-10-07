using 'main.bicep'

// Password is supplied by deploy.ps1 via VMMIG_ADMIN_PASSWORD; never commit one.
param adminPassword = readEnvironmentVariable('VMMIG_ADMIN_PASSWORD', '')
param operatorIp = ''
param enableAutoShutdown = true
