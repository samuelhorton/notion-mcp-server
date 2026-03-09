/**
 * notion.js
 * Notion API client + all tool handler implementations.
 * All functions throw descriptive errors on failure.
 */

import { Client, isFullPage, isFullBlock } from "@notionhq/client";

// ─── Client ──────────────────────────────────────────────────────────────────

if (!process.env.NOTION_API_KEY) {
  console.error("FATAL: NOTION_API_KEY environment variable is not set.");
  process.exit(1);
}

export const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  notionVersion: process.env.NOTION_VERSION || "2022-06-28",
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract plain-text title from a page's properties. */
export function extractTitle(properties = {}) {
  for (const prop of Object.values(properties)) {
    if (prop.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return "(Untitled)";
}

/** Convert a Notion rich-text array to a plain string. */
export function rt(arr = []) {
  return arr.map((t) => t.plain_text).join("");
}

/** Summarise a page to a concise object safe for returning as tool output. */
export function summarisePage(page) {
  if (!isFullPage(page)) return { id: page.id };
  return {
    id: page.id,
    title: extractTitle(page.properties),
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    parent: page.parent,
  };
}

/**
 * Convert Notion blocks to readable plain text.
 * Recurses into children up to a reasonable depth.
 */
export async function blocksToText(blockId, depth = 0) {
  if (depth > 4) return ""; // safety limit
  const { results } = await notion.blocks.children.list({
    block_id: blockId,
    page_size: 100,
  });

  const lines = [];
  const pad = "  ".repeat(depth);

  for (const block of results) {
    if (!isFullBlock(block)) continue;

    let line = "";
    switch (block.type) {
      case "paragraph":
        line = pad + rt(block.paragraph.rich_text);
        break;
      case "heading_1":
        line = pad + "# " + rt(block.heading_1.rich_text);
        break;
      case "heading_2":
        line = pad + "## " + rt(block.heading_2.rich_text);
        break;
      case "heading_3":
        line = pad + "### " + rt(block.heading_3.rich_text);
        break;
      case "bulleted_list_item":
        line = pad + "• " + rt(block.bulleted_list_item.rich_text);
        break;
      case "numbered_list_item":
        line = pad + "- " + rt(block.numbered_list_item.rich_text);
        break;
      case "to_do":
        line = pad + (block.to_do.checked ? "[x] " : "[ ] ") + rt(block.to_do.rich_text);
        break;
      case "quote":
        line = pad + "> " + rt(block.quote.rich_text);
        break;
      case "callout":
        line = pad + "💬 " + rt(block.callout.rich_text);
        break;
      case "code":
        line =
          pad +
          "```" +
          block.code.language +
          "\n" +
          rt(block.code.rich_text) +
          "\n" +
          pad +
          "```";
        break;
      case "divider":
        line = pad + "---";
        break;
      case "child_page":
        line = pad + `[Child page: ${block.child_page.title}]`;
        break;
      case "child_database":
        line = pad + `[Child database: ${block.child_database.title}]`;
        break;
      default:
        line = pad + `[${block.type}]`;
    }

    if (line.trim()) lines.push(line);

    if (block.has_children) {
      const child = await blocksToText(block.id, depth + 1);
      if (child) lines.push(child);
    }
  }

  return lines.join("\n");
}

/**
 * Convert a simple markdown-ish text string into Notion block objects.
 * Supports: # h1, ## h2, ### h3, • or * bullets, 1. numbered, plain paragraphs.
 */
export function textToBlocks(text = "") {
  const blocks = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const mkText = (content) => [{ type: "text", text: { content } }];

    if (line.startsWith("### ")) {
      blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: mkText(line.slice(4)) } });
    } else if (line.startsWith("## ")) {
      blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: mkText(line.slice(3)) } });
    } else if (line.startsWith("# ")) {
      blocks.push({ object: "block", type: "heading_1", heading_1: { rich_text: mkText(line.slice(2)) } });
    } else if (line.startsWith("• ") || line.startsWith("* ")) {
      blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: mkText(line.slice(2)) } });
    } else if (/^\d+\.\s/.test(line)) {
      blocks.push({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: mkText(line.replace(/^\d+\.\s/, "")) } });
    } else {
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: mkText(line) } });
    }
  }
  return blocks;
}

// ─── Tool Handlers ───────────────────────────────────────────────────────────

/**
 * search_notion
 * Searches the workspace for pages and/or databases matching a query.
 */
export async function searchNotion({ query, filter_type, page_size = 20 }) {
  const params = { query, page_size: Math.min(page_size, 100) };
  if (filter_type === "page" || filter_type === "database") {
    params.filter = { value: filter_type, property: "object" };
  }

  const resp = await notion.search(params);

  const results = resp.results.map((item) => {
    if (item.object === "page" && isFullPage(item)) {
      return {
        object: "page",
        id: item.id,
        title: extractTitle(item.properties),
        url: item.url,
        last_edited_time: item.last_edited_time,
        parent: item.parent,
      };
    }
    if (item.object === "database") {
      return {
        object: "database",
        id: item.id,
        title: rt(item.title),
        url: item.url,
        last_edited_time: item.last_edited_time,
      };
    }
    return { object: item.object, id: item.id };
  });

  return {
    query,
    total_results: results.length,
    has_more: resp.has_more,
    results,
  };
}

/**
 * retrieve_page
 * Fetches a page's metadata and full block content.
 */
export async function retrievePage({ page_id, include_content = true }) {
  const page = await notion.pages.retrieve({ page_id });
  const summary = summarisePage(page);

  if (!include_content) return summary;

  const content = await blocksToText(page_id);
  return { ...summary, content: content || "(empty page)" };
}

/**
 * create_page
 * Creates a new page under a parent page or as a database row.
 * For standalone pages: provide parent_page_id and title.
 * For database rows: provide parent_database_id and properties (raw Notion properties object).
 */
export async function createPage({
  parent_page_id,
  parent_database_id,
  title,
  content,
  properties,
}) {
  if (!parent_page_id && !parent_database_id) {
    throw new Error("Either parent_page_id or parent_database_id is required.");
  }

  const parent = parent_database_id
    ? { database_id: parent_database_id }
    : { page_id: parent_page_id };

  let pageProperties;

  if (parent_database_id && properties) {
    // Caller provided raw Notion properties for a database row
    pageProperties = properties;
    // Inject title if provided and not already in properties
    if (title && !pageProperties.title) {
      pageProperties.title = {
        title: [{ type: "text", text: { content: title } }],
      };
    }
  } else {
    // Standalone page under a parent page
    pageProperties = {
      title: {
        title: [{ type: "text", text: { content: title || "" } }],
      },
    };
  }

  const children = content ? textToBlocks(content) : [];

  const page = await notion.pages.create({
    parent,
    properties: pageProperties,
    children,
  });

  return summarisePage(page);
}

/**
 * update_page
 * Updates page properties. To change a page title, pass:
 *   properties: { title: { title: [{ type: "text", text: { content: "New Title" } }] } }
 * To archive a page, pass: archived: true
 */
export async function updatePage({ page_id, properties, archived }) {
  const params = { page_id };
  if (properties) params.properties = properties;
  if (archived !== undefined) params.archived = archived;

  if (!properties && archived === undefined) {
    throw new Error("Provide at least one of: properties, archived.");
  }

  const updated = await notion.pages.update(params);
  return summarisePage(updated);
}

/**
 * append_to_page
 * Appends content blocks to the end of a page.
 * Supports simple markdown-ish text: headings, bullets, numbered lists, paragraphs.
 */
export async function appendToPage({ page_id, content }) {
  if (!content?.trim()) {
    throw new Error("content must be a non-empty string.");
  }

  const blocks = textToBlocks(content);

  const result = await notion.blocks.children.append({
    block_id: page_id,
    children: blocks,
  });

  return {
    page_id,
    blocks_appended: result.results.length,
    message: `Successfully appended ${result.results.length} block(s) to the page.`,
  };
}
