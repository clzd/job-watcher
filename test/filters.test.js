import { test } from "node:test";
import assert from "node:assert/strict";
import { passesTitleFilter, passesLocationFilter, passesAtsTitleFilter } from "../src/filters.js";

const job = (title, location) => ({ title, location });

test("title filter drops whole-word intern and junior, case-insensitive", () => {
  const dropped = [
    "Intern",
    "INTERN",
    "Junior Developer",
    "Web Manager (Intern)",
    "Marketing intern, remote",
  ];
  for (const title of dropped) {
    assert.equal(passesTitleFilter(job(title)), false, title);
  }
});

test("title filter keeps titles where intern is only part of a word", () => {
  const kept = [
    "Senior Web Manager",
    "International Web Manager",
    "Internal Tools Manager",
    "Internship Coordinator",
  ];
  for (const title of kept) {
    assert.equal(passesTitleFilter(job(title)), true, title);
  }
});

test("title filter keeps a job with no title", () => {
  assert.equal(passesTitleFilter({}), true);
});

test("location filter keeps remote in the title even when location is elsewhere", () => {
  const j = job("Web Manager (Remote)", {
    display_name: "Austin, Texas",
    area: ["US", "Texas", "Austin"],
  });
  assert.equal(passesLocationFilter(j), true);
});

test("location filter keeps remote in display_name, any case", () => {
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "Remote, US", area: ["US"] })), true);
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "REMOTE - United States", area: ["US"] })), true);
});

test("location filter keeps Florida in area", () => {
  const j = job("Web Manager", {
    display_name: "Miami, Miami-Dade County",
    area: ["US", "Florida", "Miami-Dade County", "Miami"],
  });
  assert.equal(passesLocationFilter(j), true);
});

test("location filter keeps a , FL suffix and Florida in display_name", () => {
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "Tampa, FL", area: [] })), true);
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "Orlando, Florida", area: [] })), true);
});

test("location filter drops a non-remote job outside Florida", () => {
  const j = job("Web Manager", {
    display_name: "Austin, Texas",
    area: ["US", "Texas", "Austin"],
  });
  assert.equal(passesLocationFilter(j), false);
});

test("location filter does not treat FL inside a word as Florida", () => {
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "Flint, Michigan", area: ["US", "Michigan"] })), false);
});

test("location filter handles a job with no location object", () => {
  assert.equal(passesLocationFilter({ title: "Web Manager" }), false);
  assert.equal(passesLocationFilter({ title: "Remote Web Manager" }), true);
});

test("passesAtsTitleFilter keeps web, digital experience, CMS and CRO titles", () => {
  const keep = [
    "Manager, Web Content",
    "Digital Experience Specialist",
    "Lead Optimizely Solutions Architect",
    "Senior WordPress Engineer",
    "Webmaster",
    "CRO Manager",
    "Conversion Rate Optimization Lead",
    "Head of Experimentation",
    "Sr Manager, Marketing Technology",
    "MarTech Platform Delivery Manager",
    "CMS Architect",
    "Senior Software Engineer, Web",
  ];
  for (const title of keep) assert.ok(passesAtsTitleFilter({ title }), title);
});

test("passesAtsTitleFilter drops titles with no web signal", () => {
  const drop = [
    "Full Time - Merchandising Service Associate - Day",
    "Technical Support Engineer I",
    "Registered Nurse",
    "Webinar Coordinator",
    "Customer Success Associate (Denver, CO)",
    "Chief Revenue Officer",
  ];
  for (const title of drop) assert.ok(!passesAtsTitleFilter({ title }), title);
  assert.ok(!passesAtsTitleFilter({}), "missing title");
});
