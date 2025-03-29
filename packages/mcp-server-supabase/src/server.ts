import {
  PostgresMetaBase,
  wrapError,
  wrapResult,
} from '@gregnr/postgres-meta/base';
import { createMcpServer, tool } from '@supabase/mcp-utils';
import { z } from 'zod';
import { version } from '../package.json';
import {
  assertSuccess,
  createManagementApiClient,
  type ManagementApiClient,
} from './management-api/index.js';
import { generatePassword } from './password.js';
import {
  AWS_REGION_CODES,
  getClosestAwsRegion,
  getCountryCode,
  getCountryCoordinates,
} from './regions.js';

export type SupabasePlatformOptions = {
  apiUrl?: string;
  accessToken: string;
};

export type SupabaseMcpServerOptions = {
  platform: SupabasePlatformOptions;
};

/**
 * Creates an MCP server for interacting with Supabase.
 */
export function createSupabaseMcpServer(options: SupabaseMcpServerOptions) {
  const managementApiUrl =
    options.platform.apiUrl ?? 'https://api.supabase.com';

  let managementApiClient: ManagementApiClient;

  async function executeSql<T>(projectId: string, query: string): Promise<T[]> {
    const response = await managementApiClient.POST(
      '/v1/projects/{ref}/database/query',
      {
        params: {
          path: {
            ref: projectId,
          },
        },
        body: {
          query,
        },
      }
    );

    assertSuccess(response, 'Failed to execute SQL query');

    return response.data as unknown as T[];
  }

  function createPGMeta(projectId: string) {
    return new PostgresMetaBase({
      query: async (sql) => {
        try {
          const res = await executeSql(projectId, sql);
          return wrapResult<any[]>(res);
        } catch (error) {
          return wrapError(error, sql);
        }
      },
      end: async () => {},
    });
  }

  async function getClosestRegion() {
    return getClosestAwsRegion(getCountryCoordinates(await getCountryCode()))
      .code;
  }

  const server = createMcpServer({
    name: 'supabase',
    version,
    onInitialize(clientInfo) {
      managementApiClient = createManagementApiClient(
        managementApiUrl,
        options.platform.accessToken,
        {
          'User-Agent': `supabase-mcp/${version} (${clientInfo.name}/${clientInfo.version})`,
        }
      );
    },

    // Note: tools are intentionally snake_case to align better with most MCP clients
    tools: {
      list_projects: tool({
        description: 'Lists all Supabase projects for the user.',
        parameters: z.object({}),
        execute: async () => {
          const response = await managementApiClient.GET('/v1/projects');

          assertSuccess(response, 'Failed to fetch projects');

          return response.data;
        },
      }),
      get_project: tool({
        description: 'Gets a project by ID.',
        parameters: z.object({
          id: z.string().describe('The project ID'),
        }),
        execute: async ({ id }) => {
          const response = await managementApiClient.GET('/v1/projects/{ref}', {
            params: {
              path: {
                ref: id,
              },
            },
          });
          assertSuccess(response, 'Failed to fetch project');
          return response.data;
        },
      }),
      create_project: tool({
        description:
          'Creates a new Supabase project. Always ask the user which organization to create the project in. The project can take a few minutes to initialize - use `getProject` to check the status.',
        parameters: z.object({
          name: z.string().describe('The name of the project'),
          region: z.optional(
            z
              .enum(AWS_REGION_CODES)
              .describe(
                'The region to create the project in. Defaults to the closest region.'
              )
          ),
          organization_id: z.string(),
        }),
        execute: async ({ name, region, organization_id }) => {
          const response = await managementApiClient.POST('/v1/projects', {
            body: {
              name,
              region: region ?? (await getClosestRegion()),
              organization_id,
              db_pass: generatePassword({
                length: 16,
                numbers: true,
                uppercase: true,
                lowercase: true,
              }),
            },
          });

          assertSuccess(response, 'Failed to create project');

          return response.data;
        },
      }),
      list_organizations: tool({
        description: 'Lists all organizations for the user.',
        parameters: z.object({}),
        execute: async () => {
          const response = await managementApiClient.GET('/v1/organizations');

          assertSuccess(response, 'Failed to fetch organizations');

          return response.data;
        },
      }),
      get_organization: tool({
        description: 'Gets an organization by ID.',
        parameters: z.object({
          id: z.string().describe('The organization ID'),
        }),
        execute: async ({ id: organizationId }) => {
          const response = await managementApiClient.GET(
            '/v1/organizations/{slug}',
            {
              params: {
                path: {
                  slug: organizationId,
                },
              },
            }
          );

          assertSuccess(response, 'Failed to fetch organization');

          return response.data;
        },
      }),
      list_tables: tool({
        description: 'Lists all tables in a schema.',
        parameters: z.object({
          project_id: z.string(),
          schemas: z
            .optional(z.array(z.string()))
            .describe(
              'Optional list of schemas to include. Defaults to all schemas.'
            ),
        }),
        execute: async ({ project_id, schemas }) => {
          const pgMeta = createPGMeta(project_id);
          const { data, error } = await pgMeta.tables.list({
            includedSchemas: schemas,
          });

          if (error) {
            throw new Error(`Error fetching tables: ${error.message}`);
          }

          return data;
        },
      }),
      list_extensions: tool({
        description: 'Lists all extensions in the database.',
        parameters: z.object({
          project_id: z.string(),
        }),
        execute: async ({ project_id }) => {
          const pgMeta = createPGMeta(project_id);
          const { data, error } = await pgMeta.extensions.list();

          if (error) {
            throw new Error(`Error fetching extensions: ${error.message}`);
          }
          return data;
        },
      }),
      list_migrations: tool({
        description: 'Lists all migrations in the database.',
        parameters: z.object({
          project_id: z.string(),
        }),
        execute: async ({ project_id }) => {
          const response = await managementApiClient.GET(
            '/v1/projects/{ref}/database/migrations',
            {
              params: {
                path: {
                  ref: project_id,
                },
              },
            }
          );

          assertSuccess(response, 'Failed to fetch migrations');

          return response.data;
        },
      }),
      apply_migration: tool({
        description:
          'Applies a migration to the database. Use this when executing DDL operations.',
        parameters: z.object({
          project_id: z.string(),
          name: z.string().describe('The name of the migration in snake_case'),
          query: z.string().describe('The SQL query to apply'),
        }),
        execute: async ({ project_id, name, query }) => {
          const response = await managementApiClient.POST(
            '/v1/projects/{ref}/database/migrations',
            {
              params: {
                path: {
                  ref: project_id,
                },
              },
              body: {
                name,
                query,
              },
            }
          );

          assertSuccess(response, 'Failed to apply migration');

          return response.data;
        },
      }),
      execute_sql: tool({
        description:
          'Executes raw SQL in the Postgres database. Use `applyMigration` instead for DDL operations.',
        parameters: z.object({
          project_id: z.string(),
          query: z.string().describe('The SQL query to execute'),
        }),
        execute: async ({ query, project_id }) => {
          return await executeSql(project_id, query);
        },
      }),
      get_project_url: tool({
        description: 'Gets the API URL for a project.',
        parameters: z.object({
          project_id: z.string(),
        }),
        execute: async ({ project_id }) => {
          return `https://${project_id}.supabase.co`;
        },
      }),
      get_anon_key: tool({
        description: 'Gets the anonymous API key for a project.',
        parameters: z.object({
          project_id: z.string(),
        }),
        execute: async ({ project_id }) => {
          const response = await managementApiClient.GET(
            '/v1/projects/{ref}/api-keys',
            {
              params: {
                path: {
                  ref: project_id,
                },
                query: {
                  reveal: false,
                },
              },
            }
          );

          assertSuccess(response, 'Failed to fetch API keys');

          const anonKey = response.data?.find((key) => key.name === 'anon');

          if (!anonKey) {
            throw new Error('Anonymous key not found');
          }

          return anonKey.api_key;
        },
      }),
      generate_typescript_types: tool({
        description: 'Generates TypeScript types for a project.',
        parameters: z.object({
          project_id: z.string(),
        }),
        execute: async ({ project_id }) => {
          const response = await managementApiClient.GET(
            '/v1/projects/{ref}/types/typescript',
            {
              params: {
                path: {
                  ref: project_id,
                },
              },
            }
          );

          assertSuccess(response, 'Failed to fetch TypeScript types');

          return response.data;
        },
      }),
      // Experimental features
      create_branch: tool({
        description:
          'Creates a development branch with migrations from production project.',
        parameters: z.object({
          project_id: z.string(),
          name: z
            .string()
            .default('develop')
            .describe('Name of the branch to create'),
        }),
        execute: async ({ project_id, name }) => {
          const response = await managementApiClient.POST(
            '/v1/projects/{ref}/branches',
            {
              params: {
                path: {
                  ref: project_id,
                },
              },
              body: {
                branch_name: name,
              },
            }
          );

          assertSuccess(response, 'Failed to create branch');

          return response.data;
        },
      }),
      list_branches: tool({
        description: 'Lists all development branches.',
        parameters: z.object({
          project_id: z.string(),
        }),
        execute: async ({ project_id }) => {
          const response = await managementApiClient.GET(
            '/v1/projects/{ref}/branches',
            {
              params: {
                path: {
                  ref: project_id,
                },
              },
            }
          );

          assertSuccess(response, 'Failed to list branches');

          return response.data;
        },
      }),
      delete_branch: tool({
        description: 'Deletes a development branch.',
        parameters: z.object({
          branch_id: z.string(),
        }),
        execute: async ({ branch_id }) => {
          const response = await managementApiClient.DELETE(
            '/v1/branches/{branch_id}',
            {
              params: {
                path: {
                  branch_id,
                },
              },
            }
          );

          assertSuccess(response, 'Failed to delete branch');

          return response.data;
        },
      }),
      merge_branch: tool({
        description:
          'Merges migrations and edge functions from a development branch to production.',
        parameters: z.object({
          branch_id: z.string(),
        }),
        execute: async ({ branch_id }) => {
          const response = await managementApiClient.POST(
            '/v1/branches/{branch_id}/merge',
            {
              params: {
                path: {
                  branch_id,
                },
              },
              body: {},
            }
          );

          assertSuccess(response, 'Failed to merge branch');

          return response.data;
        },
      }),
      reset_branch: tool({
        description:
          'Resets migrations of a development branch to a prior version.',
        parameters: z.object({
          branch_id: z.string(),
        }),
        execute: async ({ branch_id }) => {
          const response = await managementApiClient.POST(
            '/v1/branches/{branch_id}/reset',
            {
              params: {
                path: {
                  branch_id,
                },
              },
              body: {},
            }
          );

          assertSuccess(response, 'Failed to reset branch');

          return response.data;
        },
      }),
      rebase_branch: tool({
        description:
          'Rebases development branch on production to handle migration drift.',
        parameters: z.object({
          branch_id: z.string(),
        }),
        execute: async ({ branch_id }) => {
          const response = await managementApiClient.POST(
            '/v1/branches/{branch_id}/push',
            {
              params: {
                path: {
                  branch_id,
                },
              },
              body: {},
            }
          );

          assertSuccess(response, 'Failed to rebase branch');

          return response.data;
        },
      }),
    },
  });

  return server;
}
