targetScope = 'resourceGroup'

@description('Azure region. Retired-series quota is region specific; see docs/demo.md for fallbacks.')
param location string = resourceGroup().location

@description('Prefix for resource names.')
param prefix string = 'vmmig'

param adminUsername string = 'demoadmin'

@secure()
param adminPassword string

@description('Optional operator public IP/CIDR allowed to reach SSH/RDP inside the VNet path. Empty = no inbound rules at all. No public IPs are ever created.')
param operatorIp string = ''

@description('Enable DevTest auto-shutdown.')
param enableAutoShutdown bool = true

@description('Auto-shutdown time (HHmm, UTC).')
param autoShutdownTime string = '1900'

@description('VM fleet. gen = Hyper-V generation, os = linux|windows, avset/dataDisk = variants.')
param vms array = [
  { name: 'lnx-dsv3-g2-data', size: 'Standard_D2s_v3', os: 'linux', gen: 2, dataDisk: true, avset: false }
  { name: 'win-dsv3-g2', size: 'Standard_D2s_v3', os: 'windows', gen: 2, dataDisk: false, avset: false }
  { name: 'lnx-dsv3-g1', size: 'Standard_D2s_v3', os: 'linux', gen: 1, dataDisk: false, avset: false }
  { name: 'lnx-dsv2-g2-avs1', size: 'Standard_DS2_v2', os: 'linux', gen: 2, dataDisk: false, avset: true }
  { name: 'lnx-dsv2-g2-avs2', size: 'Standard_DS2_v2', os: 'linux', gen: 2, dataDisk: false, avset: true }
  { name: 'win-esv3-g2', size: 'Standard_E2s_v3', os: 'windows', gen: 2, dataDisk: false, avset: false }
  { name: 'lnx-av2-g1', size: 'Standard_A2_v2', os: 'linux', gen: 1, dataDisk: false, avset: false }
  { name: 'lnx-fsv2-g2', size: 'Standard_F2s_v2', os: 'linux', gen: 2, dataDisk: false, avset: false }
]

var tags = { purpose: 'vm-migrator-demo' }

var images = {
  linux: {
    '1': { publisher: 'Canonical', offer: '0001-com-ubuntu-server-jammy', sku: '22_04-lts', version: 'latest' }
    '2': { publisher: 'Canonical', offer: '0001-com-ubuntu-server-jammy', sku: '22_04-lts-gen2', version: 'latest' }
  }
  windows: {
    '1': { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2022-datacenter', version: 'latest' }
    '2': { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2022-datacenter-g2', version: 'latest' }
  }
}

var inboundRules = empty(operatorIp) ? [] : [
  {
    name: 'allow-operator-ssh-rdp'
    properties: {
      priority: 100
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: operatorIp
      sourcePortRange: '*'
      destinationAddressPrefix: 'VirtualNetwork'
      destinationPortRanges: [ '22', '3389' ]
    }
  }
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${prefix}-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: concat(inboundRules, [
      {
        name: 'deny-internet-inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ])
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [ '10.50.0.0/16' ] }
    subnets: [
      {
        name: 'workload'
        properties: {
          addressPrefix: '10.50.1.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

resource avset 'Microsoft.Compute/availabilitySets@2023-09-01' = {
  name: '${prefix}-avset'
  location: location
  tags: tags
  sku: { name: 'Aligned' }
  properties: {
    platformFaultDomainCount: 2
    platformUpdateDomainCount: 2
  }
}

resource nics 'Microsoft.Network/networkInterfaces@2023-11-01' = [for vm in vms: {
  name: '${prefix}-${vm.name}-nic'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: { id: '${vnet.id}/subnets/workload' }
          privateIPAllocationMethod: 'Dynamic'
        }
      }
    ]
  }
}]

resource vmRes 'Microsoft.Compute/virtualMachines@2023-09-01' = [for (vm, i) in vms: {
  name: '${prefix}-${vm.name}'
  location: location
  tags: tags
  properties: {
    hardwareProfile: { vmSize: vm.size }
    availabilitySet: vm.avset ? { id: avset.id } : null
    osProfile: {
      computerName: take(replace('${prefix}${vm.name}', '-', ''), vm.os == 'windows' ? 15 : 63)
      adminUsername: adminUsername
      adminPassword: adminPassword
      linuxConfiguration: vm.os == 'linux' ? { disablePasswordAuthentication: false } : null
      windowsConfiguration: vm.os == 'windows' ? { enableAutomaticUpdates: true } : null
    }
    storageProfile: {
      imageReference: images[vm.os]['${vm.gen}']
      osDisk: {
        createOption: 'FromImage'
        deleteOption: 'Delete'
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
      }
      dataDisks: vm.dataDisk ? [
        {
          lun: 0
          createOption: 'Empty'
          diskSizeGB: 32
          deleteOption: 'Delete'
          managedDisk: { storageAccountType: 'StandardSSD_LRS' }
        }
      ] : []
    }
    networkProfile: {
      networkInterfaces: [ { id: nics[i].id, properties: { deleteOption: 'Delete' } } ]
    }
  }
}]

resource shutdown 'Microsoft.DevTestLab/schedules@2018-09-15' = [for (vm, i) in vms: if (enableAutoShutdown) {
  name: 'shutdown-computevm-${prefix}-${vm.name}'
  location: location
  tags: tags
  properties: {
    status: 'Enabled'
    taskType: 'ComputeVmShutdownTask'
    dailyRecurrence: { time: autoShutdownTime }
    timeZoneId: 'UTC'
    targetResourceId: vmRes[i].id
    notificationSettings: { status: 'Disabled' }
  }
}]

output vmNames array = [for (vm, i) in vms: vmRes[i].name]
