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

@description('VM fleet: 3 Linux + 3 Windows on v1/v2/v3 sizes. gen = Hyper-V generation, security = Standard|TrustedLaunch, image = key into the images map.')
param vms array = [
  { name: 'lnx-v1-ubuntu1604-g1', size: 'Standard_F2s', os: 'linux', image: 'ubuntu1604', gen: 1, security: 'Standard', dataDisk: false, avset: false }
  { name: 'lnx-v2-ubuntu1804-g2', size: 'Standard_DS2_v2', os: 'linux', image: 'ubuntu1804', gen: 2, security: 'Standard', dataDisk: false, avset: false }
  { name: 'lnx-v3-ubuntu2004-tl', size: 'Standard_D2s_v3', os: 'linux', image: 'ubuntu2004', gen: 2, security: 'TrustedLaunch', dataDisk: false, avset: false }
  { name: 'win-v1-ws2016-g1', size: 'Standard_F2s', os: 'windows', image: 'ws2016', gen: 1, security: 'Standard', dataDisk: false, avset: false }
  { name: 'win-v2-ws2019-g2', size: 'Standard_DS2_v2', os: 'windows', image: 'ws2019', gen: 2, security: 'Standard', dataDisk: false, avset: false }
  { name: 'win-v3-ws2022-tl', size: 'Standard_D2s_v3', os: 'windows', image: 'ws2022', gen: 2, security: 'TrustedLaunch', dataDisk: false, avset: false }
]

var tags = { purpose: 'vm-migrator-demo' }

// Oldest/second/third Ubuntu LTS and WS2016/2019/2022 so the OS-age impact on migration is visible.
var images = {
  ubuntu1604: { '1': { publisher: 'Canonical', offer: 'UbuntuServer', sku: '16.04-LTS', version: 'latest' } }
  ubuntu1804: { '2': { publisher: 'Canonical', offer: 'UbuntuServer', sku: '18_04-lts-gen2', version: 'latest' } }
  ubuntu2004: { '2': { publisher: 'Canonical', offer: '0001-com-ubuntu-server-focal', sku: '20_04-lts-gen2', version: 'latest' } }
  ws2016: { '1': { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2016-Datacenter', version: 'latest' } }
  ws2019: { '2': { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2019-datacenter-gensecond', version: 'latest' } }
  ws2022: { '2': { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2022-datacenter-g2', version: 'latest' } }
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
    securityProfile: vm.security == 'TrustedLaunch' ? {
      securityType: 'TrustedLaunch'
      uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
    } : null
    storageProfile: {
      imageReference: images[vm.image]['${vm.gen}']
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
