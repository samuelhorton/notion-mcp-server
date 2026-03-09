/**
 * server.js
 * MCP Server factory. Call createNotionMCPServer() for each SSE connection.
 * Each call returns a fresh Server instance bound to the tool handlers in notion.js.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  searchNotion,
  retrievePage,
  createPage,
  updatePage,
  appendToPage,
} from "./notion.js";

// ─── Tool schemas ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_notion",
    description:
      "Search the Notion workspace for pages and databases matching a query. " +
      "Use this whenever the user asks about notes, tasks, journal entries, or any stored information.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query.",
        },
        filter_type: {
          type: "string",
          enum: ["page", "database"],
          description: "Optional. Restrict to 'page' or 'database' results only.",
        },
        page_size: {
          type: "number",
          description: "Max results to return (default 20, max 100).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "retrieve_page",
    description:
      "Retrieve the full content and metadata of a specific Notion page by its ID. " +
      "Use this to read a page after finding its ID via search_notion.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "The Notion page ID (UUID, with or without dashes).",
        },
        include_content: {
          type: "boolean",
          description:
            "Whether to fetch the page's block content. Defaults to true.",
        },
      },
      required: ["page_id"],
    },
  },
  {
    name: "create_page",
    description:
      "Create a new Notion page. Can be placed under an existing page or as a row in a database. " +
      "Use this when the user asks to create a note, entry, task, or document.",
    inputSchema: {
      type: "object",
      properties: {
        parent_page_id: {
          type: "string",
          description:
            "Parent page ID. Provide this OR parent_database_id, not both.",
        },
        parent_database_id: {
          type: "string",
          description:
            "Parent database ID (creates a database row). Provide this OR parent_page_id.",
        },
        title: {
          type: "string",
          description: "The page title.",
        },
        content: {
          type: "string",
          description:
            "Page body text. Supports simple markdown: # h1, ## h2, ### h3, • bullets, 1. numbered, plain text.",
        },
        properties: {
          type: "object",
          description:
            "Raw Notion properties object for database rows with typed columns.",
        },
      },
    },
  },
  {
    name: "update_page",
    description:
      "Update the properties of an existing Notion page, such as changing its title or archiving it. " +
      "To add new content to a page without replacing it, use append_to_page instead.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "The Notion page ID to update.",
        },
        properties: {
          type: "object",
          description:
            "Notion properties object with the fields to update. " +
            "To update the title: { title: { title: [{ type: 'text', text: { content: 'New Title' } }] } }",
        },
        archived: {
          type: "boolean",
          description: "Set to true to archive (soft-delete) the page.",
        },
      },
      required: ["page_id"],
    },
  },
  {
    name: "append_to_page",
    description:
      "Append new content to the end of an existing Notion page without overwriting it. " +
      "Ideal for adding journal entries, notes, or updates. " +
      "Content supports simple markdown: # h1, ## h2, ### h3, • bullets, 1. numbered, plain paragraphs.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "The Notion page ID to append content to.",
        },
        content: {
          type: "string",
          description: "Text to append. Supports simple markdown formatting.",
        },
      },
      required: ["page_id", "content"],
    },
  },
];

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Create a fresh MCP Server instance. Call once per SSE connection. */
export function createNotionMCPServer() {
  const server = new Server(
    { name: "notion-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let result;

      switch (name) {
        case "search_notion":
          result = await searchNotion(args);
          break;
        case "retrieve_page":
          result = await retrievePage(args);
          break;
        case "create_page":
          result = await createPage(args);
          break;
        case "update_page":
          result = await updatePage(args);
          break;
        case "append_to_page":
          result = await appendToPage(args);
          break;
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg =
        err?.body?.message ??
        err?.code ??
        err?.message ??
        "Unknown error";

      console.error(`[Tool error] ${name}:`, msg);

      return {
        content: [{ type: "text", text: `Error calling ${name}: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}
