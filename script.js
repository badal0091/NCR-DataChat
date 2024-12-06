/* global d3 */
import { render, html } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { marked } from "marked";
import { pc } from "@gramex/ui/format";
import { network } from "@gramex/network";
import { SSE } from "sse.js";

const config = document.querySelector("#config").dataset;
const $searchForm = document.querySelector("#search-form");
const $summary = document.querySelector("#summary");
const $matches = document.querySelector("#matches");
const $network = document.querySelector("#network");
const $similarity = document.querySelector("#similarity");
let result;
let graph;
let isBrushed = false;
const maxSelected = 10;

$searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Clear the summary and matches
  render(spinner("Searching knowledge base..."), $matches);
  render(html``, $summary);
  $network.replaceChildren();
  $similarity.classList.add("d-none");

  // Fetch similar documents
  const form = new FormData(e.target);
  result = { content: "" };
  const similarityResult = await fetch("../similarity?" + new URLSearchParams(form).toString()).then((d) => d.json());
  Object.assign(result, similarityResult);

  // Assign relevance to each document based on the score
  result.matches.forEach((doc) => (doc.relevance = (1.5 - doc.score) / (1.5 - 0.8)));
  // Sort by relevance
  result.matches.sort((a, b) => b.relevance - a.relevance);

  result.links = [];
  result.similarity.forEach((values, i) =>
    values.forEach((similarity, j) => {
      if (i != j) result.links.push({ source: result.matches[i], target: result.matches[j], similarity });
    }),
  );

  // Start by showing the top few links
  const similarities = result.links.map((d) => d.similarity).sort((a, b) => b - a);
  $similarity.value = similarities[Math.min(50, similarities.length - 1)];

  drawNetwork();
  brush(); // To select the top maxSelected nodes and redraw
  summarize();
});

// When the user brushes the network, redraw with only selected nodes.
// If no nodes are selected, show the first (top) maxSelected nodes.
function brush(nodes = []) {
  isBrushed = !!nodes.length;
  result.matches.forEach((match) => (match.selected = false));
  if (!nodes.length) nodes = result.matches.slice(0, maxSelected);
  nodes.forEach((node) => (node.selected = true));
  redraw();
}

const colorConfig = JSON.parse(config.color) ?? {
  field: "relevance",
  scale: "interpolateRdYlGn",
  domain: [0, 1],
  relevanceOpacity: false,
};
const scale = colorConfig.scale
  ? d3.scaleSequential(d3[colorConfig.scale]).domain(colorConfig.domain)
  : colorConfig.values
    ? d3.scaleOrdinal().domain(Object.keys(colorConfig.values)).range(Object.values(colorConfig.values))
    : colorConfig
      ? d3.scaleOrdinal().range(d3.schemeCategory10)
      : "green";
const color =
  colorConfig.field == "relevance"
    ? (d) => scale(d[colorConfig.field])
    : colorConfig.field
      ? (d) => scale(d.metadata[colorConfig.field])
      : "green";
const opacity = colorConfig.relevanceOpacity ? d3.scaleLinear().domain([0, 1]).range([0.1, 1]) : () => 1;

// Draw the network whenever the similarity changes
function drawNetwork() {
  $similarity.classList.remove("d-none");
  const minSimilarity = parseFloat($similarity.value);
  const linksFilter = result.links.filter((d) => d.similarity >= minSimilarity);
  graph = network("#network", { nodes: result.matches, links: linksFilter, brush });
  graph.nodes.attr("r", 6).attr("stroke", "rgba(var(--bs-body-color-rgb), 0.2)");
  graph.nodes.attr("fill", color);
  graph.nodes.attr("opacity", ({ relevance }) => opacity(relevance));
  graph.links.attr("stroke", "rgba(var(--bs-body-color-rgb), 0.2)").attr("stroke-width", 2);
}

$similarity.addEventListener("input", drawNetwork);

async function summarize(q) {
  const form = new FormData($searchForm);
  result.content = "";
  result.done = false;
  if (!q) q = form.get("q");
  redraw();

  const payload = JSON.stringify({
    app: form.get("app"),
    Tone: form.get("Tone"),
    Format: form.get("Format"),
    Language: form.get("Language"),
    Followup: form.get("Followup"),
    q,
    context: result.matches
      .filter((d) => d.selected)
      .slice(0, maxSelected)
      .map((d, i) => `DOC_ID: ${i + 1}\nTITLE: ${d.metadata.h1}\n${d.page_content}\n`)
      .join("\n"),
  });

  const source = new SSE("../summarize", { payload, start: false });
  source.addEventListener("message", (event) => {
    if (event.data == "[DONE]") result.done = true;
    else {
      try {
        result.content += JSON.parse(event.data).choices?.[0]?.delta?.content ?? "";
      } catch (err) {
        console.error("Non JSON message", event.data);
        result.error = err.message;
      }
    }
    redraw();
  });
  source.stream();
}

const spinner = (message) =>
  html`<div class="my-5 d-flex justify-content-center align-items-center w-100">
    <div class="spinner-grow text-primary" aria-hidden="true"></div>
    <strong class="ms-2 display-6" role="status">${message}</strong>
  </div>`;

const alertMsg = (message, error, type = "danger") =>
  html`<div class="alert alert-${type}" role="alert">
    <p>${message}</p>
    <pre style="white-space: pre-wrap">${error}</pre>
  </div>`;

const redraw = () => {
  render(
    result.error
      ? alertMsg("Sorry, I cannot summarize. I got this error:", result.error.data)
      : result.content.length
        ? html`<div class="my-3">
            <h2 class="h4">Summary</h2>
            ${unsafeHTML(marked.parse(result.content))}
            ${result.done ? "" : html`<div class="spinner-grow spinner-grow-sm text-primary" aria-hidden="true"></div>`}
          </div>`
        : spinner("Summarizing results..."),
    $summary,
  );
  render(
    result.matches && result.matches.length
      ? searchList(result)
      : html`<div class="alert alert-danger" role="alert">No matches found. Try another search.</div>`,
    $matches,
  );
  // All snippet links should open in a new tab
  $matches.querySelectorAll(".search-snippet a").forEach((a) => a.setAttribute("target", "_blank"));
};

const searchList = ({ matches }) => {
  const selected = matches.filter((d) => d.selected);
  const grouped = d3.group(selected, (d) => d.metadata.key);
  const searchList = [];
  if (matches[0].relevance < config.minSimilarity) {
    searchList.push(
      html`<div class="alert alert-danger alert-dismissible fade show" role="alert">
        No good results. Showing some diverse areas to explore.
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
      </div>`,
    );
  }
  const selectedLength = matches.filter((d) => d.selected).length;
  searchList.push(html`
    <div class="my-3 d-flex">
      <button type="button" class="btn btn-success btn-sm me-auto summarize-snippets" ?disabled=${!isBrushed}>
        <i class="bi bi-magic"></i> Summarize
      </button>
      ${selectedLength >= maxSelected
        ? null
        : html`<button class="btn btn-outline-primary btn-sm me-2 show-all">
            <i class="bi bi-x-circle-fill"></i> Show all
          </button>`}
      <div class="btn-group" role="group" aria-label="Basic example">
        <button class="btn btn-primary btn-sm expand-snippets"><i class="bi bi-arrows-expand"></i> Expand</button>
        <button class="btn btn-primary btn-sm collapse-snippets"><i class="bi bi-arrows-collapse"></i> Collapse</button>
      </div>
    </div>
  `);
  grouped.forEach((docs, key) => {
    searchList.push(html`
      <div class="my-3 search-item">
        <a class="fs-5 text-decoration-none" href="${config.link.replace("🔑", key)}" target="_blank" rel="noopener">
          <i class="bi bi-circle-fill small" style="color:${color(docs[0])};opacity:${opacity(docs[0].relevance)}"></i>
          ${docs[0].metadata.h1}</a
        >
        <small>(${pc(Math.min(1, docs[0].relevance))})</small>
        <div class="bg-secondary">
          <div class="bg-danger" style="width: ${pc(Math.min(1, docs[0].relevance))}; height:2px"></div>
        </div>

        <div class="search-snippet cursor-pointer py-2 ${config.openSnippets ? "" : "closed"}">
          <ul class="list-group">
            ${docs.map((doc) => html`<li class="list-group-item">${unsafeHTML(marked.parse(doc.page_content))}</li>`)}
          </ul>
        </div>
      </div>
    `);
  });
  return searchList;
};

$matches.addEventListener("click", (e) => {
  // Clicking on a snippet toggles it open/closed, unless it's a link (which'll open in a new tab)
  const $snippet = e.target.closest(".search-snippet");
  if ($snippet && !e.target.closest("a")) $snippet.classList.toggle("closed");
  const $expandSnippets = e.target.closest(".expand-snippets");
  if ($expandSnippets) $matches.querySelectorAll(".search-snippet").forEach((d) => d.classList.remove("closed"));
  const $collapseSnippets = e.target.closest(".collapse-snippets");
  if ($collapseSnippets) $matches.querySelectorAll(".search-snippet").forEach((d) => d.classList.add("closed"));
  const $summarizeSnippets = e.target.closest(".summarize-snippets");
  if ($summarizeSnippets) summarize("What's common in these documents?");
  const $showAll = e.target.closest(".show-all");
  if ($showAll) {
    brush();
    $matches.querySelectorAll(".search-snippet").forEach((d) => d.classList.add("closed"));
  }
});

document.querySelector("#sample-questions").addEventListener("click", (e) => {
  const $question = e.target.closest(".question");
  if ($question) {
    $searchForm.querySelector("input[name=q]").value = $question.textContent;
    $searchForm.dispatchEvent(new Event("submit", { bubbles: true }));
  }
});

$summary.addEventListener("click", (e) => {
  const $link = e.target.closest("a");
  if ($link) e.preventDefault();
  // If the user clicks on a followup question, search for it
  if ($link.href.match(/#suggestion/)) {
    $searchForm.querySelector("input[name=q]").value = $link.textContent;
    $searchForm.dispatchEvent(new Event("submit", { bubbles: true }));
    $searchForm.scrollIntoView({ behavior: "smooth" });
  } else if ($link.href.match(/#\d+/)) {
    const index = $link.href.split("#")[1] - 1;
    // Highlight the citation and draw it
    result.matches.forEach((match, i) => (match.selected = i == index));
    redraw();
    // Expact the citation
    $matches.querySelectorAll(".search-snippet").forEach((d) => d.classList.remove("closed"));
    // Scroll to the citation
    $matches.scrollIntoView({ behavior: "smooth" });
  }
});
