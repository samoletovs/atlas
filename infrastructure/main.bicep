// atlas — Phase 0 infrastructure
// Provisions Cosmos DB (serverless), Static Web App, Functions plan, App Insights.
// Reuses the foundryLab Foundry account for the lesson-generation agent — no AOAI here.
//
// Naming convention: atlas-<resource> (per .github/instructions/azure-bicep.instructions.md)

targetScope = 'resourceGroup'

@description('Short project key used in resource names')
param projectKey string = 'atlas'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Object ID of the user that should get Cosmos DB Built-in Data Contributor on the Cosmos account')
param ownerObjectId string

@description('Common resource tags')
param tags object = {
  project: 'atlas'
  environment: 'production'
  managedBy: 'bicep'
  costCenter: 'naurolabs-research'
}

// ---------------------------------------------------------------------------
// Log Analytics + App Insights
// ---------------------------------------------------------------------------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${projectKey}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${projectKey}-appi'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// ---------------------------------------------------------------------------
// Cosmos DB — serverless, AAD-only access
// ---------------------------------------------------------------------------

// Cosmos DB account name needs to be globally unique — add a stable hash suffix
var cosmosAccountName = '${projectKey}-cosmos-${uniqueString(resourceGroup().id, projectKey)}'

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: cosmosAccountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capacityMode: 'Serverless'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      { locationName: location, failoverPriority: 0, isZoneRedundant: false }
    ]
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
  }
}

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-12-01-preview' = {
  parent: cosmos
  name: 'atlas'
  properties: {
    resource: { id: 'atlas' }
  }
}

resource lessonsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = {
  parent: cosmosDb
  name: 'lessons'
  properties: {
    resource: {
      id: 'lessons'
      partitionKey: {
        paths: [ '/userId' ]
        kind: 'Hash'
      }
      defaultTtl: -1
    }
  }
}

resource topicsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = {
  parent: cosmosDb
  name: 'topics'
  properties: {
    resource: {
      id: 'topics'
      partitionKey: {
        paths: [ '/userId' ]
        kind: 'Hash'
      }
    }
  }
}

resource activityContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = {
  parent: cosmosDb
  name: 'activity_events'
  properties: {
    resource: {
      id: 'activity_events'
      partitionKey: {
        paths: [ '/userId' ]
        kind: 'Hash'
      }
    }
  }
}

// Built-in Cosmos DB Data Contributor role for the owner
// This is a SQL role assignment, not an Azure RBAC role
resource cosmosDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-12-01-preview' = {
  parent: cosmos
  name: guid(cosmos.id, ownerObjectId, 'data-contributor')
  properties: {
    principalId: ownerObjectId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: cosmos.id
  }
}

// ---------------------------------------------------------------------------
// Static Web App — Free tier, with built-in Azure Functions
// ---------------------------------------------------------------------------

resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: '${projectKey}-swa'
  location: 'westeurope' // SWA Free tier is region-restricted
  tags: tags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    repositoryUrl: 'https://github.com/samoletovs/atlas'
    branch: 'main'
    buildProperties: {
      appLocation: '/'
      apiLocation: 'api'
      outputLocation: 'dist'
    }
  }
}

// SWA app settings — backend Functions read these
resource swaSettings 'Microsoft.Web/staticSites/config@2024-04-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    COSMOS_ENDPOINT: cosmos.properties.documentEndpoint
    COSMOS_DATABASE: 'atlas'
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
    NODE_ENV: 'production'
    ATLAS_USER_ID: 'sam'
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('Cosmos DB endpoint')
output cosmosEndpoint string = cosmos.properties.documentEndpoint

@description('Cosmos DB account resource ID')
output cosmosAccountId string = cosmos.id

@description('Static Web App default hostname')
output swaHostname string = swa.properties.defaultHostname

@description('Static Web App resource ID (for swa CLI deploys)')
output swaId string = swa.id

@description('Static Web App name')
output swaName string = swa.name

@description('App Insights connection string')
output appInsightsConnectionString string = appInsights.properties.ConnectionString
