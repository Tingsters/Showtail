import { describe, expect, test } from 'bun:test';
import { parseTranscript } from '../src/core/chatgpt.ts';
import { cleanup, makeTempDir } from './helpers.ts';
// A real page-copy (flattened): no role markers, ChatGPT chrome and attachment
// chips mixed in, and the image-generation turns leave only "Thought for Ns Edit".
const PASTE_NO_MARKERS = `Help me out with writing exercises for the Functions section of my book. The exercises should be in a prompt first style where the reader gets a task they can accomplish with AI. Here are some examples of exercises in other chapters:Hammy Exercises1. Prompt the AI to add a line of user input to ask what Hammy is doing.2. Create a new function called hammy_night, which includes Hammy's nighttime activities.And here is the section I need to write exercises for:Pasted text(9).txtDocumentnow give me some exercises for this section:Pasted text(10).txtDocumentnow create exercises for each section: Lambda Functions, Map Thank-you Cards, Filter Goats, "Reduce, Adding Eggs" using the books content reinforce each concept taught in each section:Pasted text(11).txtDocumenthere is a chapter outline for an ai first programming book. improve the outline for chapter 6. in the book i already wrote about classes and methods. :Pasted text(13).txtDocumentOk, let's use this as the Chapter 6 outline: Classes and Objects, Constructors, Methods, Encapsulation, Inheritance, Method Overriding, Composition. I already finished the first 3 sections. Give me some choices for an robot pet shelter example that shows encapsulation.I pasted in the chapter text so far for context:Pasted text(15).txtDocumentI going to start working the last section for composition. Give some choices for a scenario I could use to write about composition. Here is the chapter so far:Pasted text(16).txtDocumenti just finished writing my chapter about object oriented programming. i need to create exercises for each section of the book. I pasted in my chapter text for reference.Draw me a picture of a robot dog using a similar style. have it be a friendly large style breed, but not a golden retriever since i already used that in my book.Thought for 43sEditThought for 48sEditThought for 45sEditThought for 43sEditThought for 42sEditThought for 48sEditThought for 49sEditdraw the silhouette of a mystery robot pet. base it off of the robot dog.Thought for 47sEditmake it a softer blue silhouette with no shadows in on the white backgroundThought for 40sEdit`;
const PASTE_WITH_MARKERS = `You said:
How do I reverse a string in Python?
ChatGPT said:
Use slicing: s[::-1].
You said:
Thanks!`;
describe('parseTranscript', () => {
  test('no markers: strips chrome + attachment chips and records prompts', () => {
    const { conversation, markersFound } = parseTranscript(PASTE_NO_MARKERS);
    expect(markersFound).toBe(false);
    const texts = conversation.messages.map((m) => m.text);
    expect(conversation.messages.every((m) => m.role === 'user')).toBe(true);
    // Chrome is gone; attachment chips are normalized (no raw "...Document").
    expect(texts.some((t) => /Thought for/.test(t))).toBe(false);
    expect(texts.some((t) => /txtDocument/.test(t))).toBe(false);
    expect(texts.some((t) => t.includes('[attachment: Pasted text(9).txt]'))).toBe(true);
    // The student's prompts survive, first to last.
    expect(texts[0]).toContain('Help me out with writing exercises');
    expect(texts.some((t) => t.includes('silhouette of a mystery robot pet'))).toBe(true);
    expect(texts[texts.length - 1]).toContain('softer blue silhouette');
  });
  test('with markers: splits user prompts and assistant responses', () => {
    const { conversation, markersFound } = parseTranscript(PASTE_WITH_MARKERS);
    expect(markersFound).toBe(true);
    expect(conversation.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(conversation.messages[0]!.text).toContain('reverse a string');
    expect(conversation.messages[1]!.text).toContain('s[::-1]');
  });
});
describe('paste import (end to end)', () => {});
