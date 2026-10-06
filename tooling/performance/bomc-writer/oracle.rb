require 'json'
require 'digest'
require_relative '../../../../bom_engine_plugin/bom_engine/bomc_decoder'

def f64_hex(values)
  values.map { |value| [value].pack('E').unpack1('H*') }
end

def read_reference(bytes, cursor, width)
  value = case width
          when 1 then bytes.getbyte(cursor)
          when 2 then bytes.byteslice(cursor, 2).unpack1('v')
          when 4 then bytes.byteslice(cursor, 4).unpack1('V')
          else raise "unsupported adaptive width #{width}"
          end
  sentinel = (1 << (width * 8)) - 1
  [value == sentinel ? nil : value, cursor + width]
end

def authoring_rows(bytes, strings)
  section = BOMEngine::BOMC::Container.parse(bytes)[:sections].find { |row| row[:type] == 241 }
  raise 'missing BWEB section 241' unless section
  raw = section[:bytes]
  raise 'bad BWEB authoring header' unless raw.byteslice(0, 4) == 'BWEB' && raw.byteslice(4, 2).unpack1('v') == 1
  width = raw.getbyte(6)
  raise 'unsupported BWEB capability' unless [1, 2, 4].include?(width) && raw.byteslice(8, 4).unpack1('V') == 1
  revision = raw.byteslice(12, 8).unpack1('Q<')
  cursor = 20
  document_row, cursor = read_reference(raw, cursor, width)
  counts = 5.times.map { |index| raw.byteslice(cursor + index * 4, 4).unpack1('V') }
  cursor += 20
  labels = %w[materials definitions meshes faces instances]
  ids = {}
  labels.zip(counts).each do |label, count|
    ids[label] = Array.new(count) do
      row, cursor = read_reference(raw, cursor, width)
      raise "#{label} ID points to a missing string" unless row && strings[row]
      strings[row]
    end
  end
  raise 'BWEB section contains trailing bytes' unless cursor == raw.bytesize
  raise 'document ID points to a missing string' unless document_row && strings[document_row]
  { schema: 1, revision: revision, document_id: strings[document_row], counts: counts, ids: ids }
end

def area_from_triangles(positions, indices)
  indices.each_slice(3).sum do |a, b, c|
    p0 = positions[a * 3, 3]; p1 = positions[b * 3, 3]; p2 = positions[c * 3, 3]
    u = 3.times.map { |axis| p1[axis] - p0[axis] }
    v = 3.times.map { |axis| p2[axis] - p0[axis] }
    cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    Math.sqrt(cross.sum { |value| value * value }) * 0.5
  end
end

path = ARGV.fetch(0)
bytes = File.binread(path)
decoded = BOMEngine::BOMCDecoder.decode(bytes)
authoring = authoring_rows(bytes, decoded.fetch(:strings))
raise 'BWEB row counts differ from decoded graph' unless authoring[:counts] == [decoded[:materials].length, decoded[:definitions].length, decoded[:meshes].length, decoded[:meshes].sum { |mesh| mesh[:faces].length }, decoded[:instances].length]

materials = decoded[:materials].each_with_index.map do |material, index|
  {
    id: authoring[:ids]['materials'][index], name: material[:name], display_name: material[:display_name],
    rgba: material[:color].values, opacity_u16: (material[:opacity] * 65_535).round, texture: material[:texture]
  }
end
definitions = decoded[:definitions].each_with_index.map do |definition, index|
  kind_code = BOMEngine::BOMC::DEFINITION_NAMES.key(definition[:kind])
  kind = { 1 => 'model', 2 => 'component', 3 => 'group' }.fetch(kind_code)
  { id: authoring[:ids]['definitions'][index], name: definition[:name], kind: kind,
    mesh_id: definition[:mesh].nil? ? nil : authoring[:ids]['meshes'][definition[:mesh]] }
end
face_row = 0
meshes = decoded[:meshes].each_with_index.map do |mesh, mesh_index|
  faces = mesh[:faces].each_with_index.map do |face, local_index|
    row = face_row
    face_row += 1
    {
      id: authoring[:ids]['faces'][row], outer: face[:outer], holes: face[:holes], triangles: face[:triangles],
      normal: f64_hex(face[:normal]), surface: BOMEngine::BOMC::SURFACE_NAMES.key(face[:surface_type]), hidden: face[:hidden], role: BOMEngine::BOMC::SEMANTIC_ROLE_NAMES.key(face[:semantic_role]),
      front_material: face[:front_material].nil? ? nil : authoring[:ids]['materials'][face[:front_material]],
      back_material: face[:back_material].nil? ? nil : authoring[:ids]['materials'][face[:back_material]],
      label: face[:semantic_label], area: area_from_triangles(mesh[:positions], face[:triangles])
    }
  end
  {
    id: authoring[:ids]['meshes'][mesh_index], definition: authoring[:ids]['definitions'][mesh[:definition]],
    positions_f64le: f64_hex(mesh[:positions]), faces: faces,
    edges: mesh[:edges].map { |edge| edge[:vertices] }
  }
end
instances = decoded[:instances].each_with_index.map do |instance, index|
  matrix = decoded[:transforms][instance[:transform]]
  kind_code = BOMEngine::BOMC::NODE_NAMES.key(instance[:kind])
  kind = { 1 => 'root', 2 => 'component', 3 => 'group' }.fetch(kind_code)
  {
    id: authoring[:ids]['instances'][index], name: instance[:name], kind: kind,
    owner: instance[:owner_definition].nil? ? nil : authoring[:ids]['definitions'][instance[:owner_definition]],
    definition: instance[:definition].nil? ? nil : authoring[:ids]['definitions'][instance[:definition]],
    material: instance[:material].nil? ? nil : authoring[:ids]['materials'][instance[:material]],
    visible: instance[:visible], role: BOMEngine::BOMC::SEMANTIC_ROLE_NAMES.key(instance[:semantic_role]), label: instance[:semantic_label], matrix_f64le: f64_hex(matrix)
  }
end
output = {
  source_sha256: Digest::SHA256.hexdigest(bytes),
  format: decoded[:format], source: decoded[:source], coordinate_system: decoded[:coordinate_system], bounds: decoded[:bounds],
  authoring: authoring, counts: {
    materials: materials.length, meshes: meshes.length, faces: meshes.sum { |mesh| mesh[:faces].length },
    definitions: definitions.length, instances: instances.length, transforms: decoded[:transforms].length,
    edges: meshes.sum { |mesh| mesh[:edges].length }
  }, materials: materials, definitions: definitions, meshes: meshes, instances: instances
}
if ARGV[1] == 'summary'
  faces = meshes.flat_map { |mesh| mesh[:faces] }
  summary = {
    source_sha256: output[:source_sha256], format: output[:format], authoring: output[:authoring], counts: output[:counts],
    bounds: output[:bounds],
    first_position_f64le: meshes.first&.dig(:positions_f64le, 0),
    last_position_f64le: meshes.last&.dig(:positions_f64le, -1),
    first_face: faces.first && faces.first.slice(:id, :outer, :holes, :triangles, :normal, :surface, :hidden, :role),
    last_face: faces.last && faces.last.slice(:id, :outer, :holes, :triangles, :normal, :surface, :hidden, :role),
    first_instance: instances.first && instances.first.slice(:id, :name, :kind, :owner, :definition, :visible, :matrix_f64le),
    last_instance: instances.last && instances.last.slice(:id, :name, :kind, :owner, :definition, :visible, :matrix_f64le)
  }
  puts JSON.generate(summary)
else
  puts JSON.generate(output)
end
