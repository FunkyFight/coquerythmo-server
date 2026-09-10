const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectDistribution } = require('../src/project_distribution');
const { Room } = require('../src/room');

const metadata = { request_id: 'project', total_bytes: 100, project_huuid: 'huuid' };
function socket(id) { return { id, events: [], emit(event, data) { this.events.push([event, data]); } }; }
function fixture() {
  const director = socket('director');
  const actor = socket('actor');
  const room = new Room('ROOM', director, 'DA', 'huuid', 'director-session');
  room.addMember(actor, 'Actor', 'actor', 'actor-session');
  return { room, director, actor, distribution: new ProjectDistribution(room) };
}

test('upload begins without waiting for actors and offers nothing until it is verified', () => {
  const { distribution, actor } = fixture();
  distribution.begin(metadata);
  assert.equal(distribution.status().phase, 'uploading');
  assert.equal(actor.events.length, 0);
  distribution.publish(metadata);
  assert.equal(actor.events[0][0], 'project_transfer_request');
});

test('one slow or refusing actor never holds up another download', () => {
  const { room, distribution, actor } = fixture();
  const slow = socket('slow');
  room.addMember(slow, 'Slow', 'actor', 'slow-session');
  distribution.begin(metadata);
  distribution.publish(metadata);
  distribution.respond(actor, 'project', 'accepted');
  assert.equal(distribution.canDownload(actor, 'project'), true);
  assert.equal(distribution.canDownload(slow, 'project'), false);
  distribution.respond(slow, 'project', 'refused');
  assert.equal(distribution.canDownload(actor, 'project'), true);
});

test('rejoining a completed download never restarts the upload or other downloads', () => {
  const { room, distribution, actor } = fixture();
  distribution.begin(metadata);
  distribution.publish(metadata);
  distribution.respond(actor, 'project', 'accepted');
  distribution.result(actor, 'project', true);
  room.removeMember(actor);
  const replacement = socket('replacement');
  room.addMember(replacement, 'Actor', 'actor', 'actor-session');
  distribution.join(replacement);
  assert.equal(distribution.status().participants[0].response, 'loaded');
  assert.equal(replacement.events.length, 0);
});

test('a late member can download the published project even after the DA leaves', () => {
  const { room, distribution, director } = fixture();
  distribution.begin(metadata);
  distribution.publish(metadata);
  room.removeMember(director, true);
  const late = socket('late');
  room.addMember(late, 'Late', 'actor', 'late-session');
  distribution.join(late);
  assert.equal(late.events[0][1].request_id, 'project');
  distribution.respond(late, 'project', 'accepted');
  assert.equal(distribution.canDownload(late, 'project'), true);
});

test('late duplicate refusals cannot cancel an accepted or completed download', () => {
  const { distribution, actor } = fixture();
  distribution.begin(metadata);
  distribution.publish(metadata);
  distribution.respond(actor, 'project', 'accepted');
  distribution.result(actor, 'project', true);
  distribution.respond(actor, 'project', 'refused');
  assert.equal(distribution.status().participants[0].response, 'loaded');
  assert.throws(() => distribution.result(actor, 'another-transfer', false), /unknown_project_transfer/);
});

test('a targeted invitation still makes the cache available to late arrivals', () => {
  const { room, distribution, actor } = fixture();
  const bystander = socket('bystander');
  room.addMember(bystander, 'Bystander', 'actor', 'bystander-session');
  distribution.begin(metadata, actor.id);
  distribution.publish(metadata);
  assert.equal(bystander.events.length, 0);
  const late = socket('late');
  room.addMember(late, 'Late', 'actor', 'late-session');
  distribution.join(late);
  assert.equal(late.events[0][1].request_id, 'project');
});

test('a failed recipient can accept again after reconnecting', () => {
  const { room, distribution, actor } = fixture();
  distribution.begin(metadata);
  distribution.publish(metadata);
  distribution.respond(actor, 'project', 'accepted');
  distribution.result(actor, 'project', false, 'disk full');
  room.removeMember(actor);
  const replacement = socket('replacement');
  room.addMember(replacement, 'Actor', 'actor', 'actor-session');
  distribution.join(replacement);
  distribution.respond(replacement, 'project', 'accepted');
  assert.equal(distribution.canDownload(replacement, 'project'), true);
  assert.equal(distribution.status().participants[0].error, undefined);
});
