# frozen_string_literal: true

require 'digest'
require 'json'
require 'fileutils'

def parse_options(argv)
	options = {}
	until argv.empty?
		key = argv.shift
		value = argv.shift
		raise "Missing value for #{key}" if value.nil?
		options[key] = value
	end
	options
end

def sha256(path)
	Digest::SHA256.file(path).hexdigest
end

def write_json(path, value, immutable: false)
	bytes = JSON.pretty_generate(value) + "\n"
	if immutable && File.exist?(path)
		unless File.binread(path) == bytes
			raise "Refusing to replace immutable Ruby oracle output: #{path}"
		end
		return
	end
	File.write(path, bytes)
end

options = parse_options(ARGV)
workspace_root = File.expand_path(options.fetch('--workspace-root'))
output_dir = File.expand_path(options.fetch('--output-dir'))
vectors_output = File.expand_path(options.fetch('--vectors-output'))
producer_root = File.join(workspace_root, 'bom_engine_plugin')
editor_root = File.join(workspace_root, 'sibambo-editor')
manifest_path = File.join(editor_root, 'tooling', 'performance', 'fixtures.json')
metadata_path = File.join(output_dir, 'metadata.json')

require File.join(producer_root, 'bom_engine', 'bomc_decoder')
require File.join(producer_root, 'bom_engine', 'bomc_sketchup_colorize')

manifest = JSON.parse(File.read(manifest_path))
expected_hashes = {
	'S1-new' => 'd306fb89c0a59edf5ecdbcaf26d27e795e521cceb1c689e59958e1038932918c',
	'S2-new' => 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452',
	'I-new' => '01bf898df9a8b377f4d48ea4825c51427f2e18dbded865144363d5642a235825',
	'Y-new' => '5bca4efdf0ac4f502b810179d51e49defbbc63406e98bb1f7641db1fb1d14c6f'
}
fixtures = manifest.fetch('fixtures').select { |fixture| expected_hashes.key?(fixture.fetch('id')) }
raise 'Pinned fixture manifest is missing one of the four MATERIALS-v2 files' unless fixtures.length == expected_hashes.length

fixture_metadata = fixtures.map do |fixture|
	path = File.join(workspace_root, fixture.fetch('locator'))
	bytes = File.binread(path)
	actual_hash = Digest::SHA256.hexdigest(bytes)
	unless bytes.bytesize == fixture.fetch('bytes') && actual_hash == fixture.fetch('sha256') && actual_hash == expected_hashes.fetch(fixture.fetch('id'))
		raise "Pinned fixture identity mismatch for #{fixture.fetch('id')}"
	end

	decoder = BOMEngine::BOMCDecoder::Decoder.new(bytes, allow_jpeg_color_map: false)
	strings = decoder.send(:decode_strings, decoder.send(:section_bytes, BOMEngine::BOMC::SECTION_STRINGS))
	rows = decoder.send(:decode_materials, decoder.send(:section_bytes, BOMEngine::BOMC::SECTION_MATERIALS), strings)
	materials = rows.each_with_index.map do |row, index|
		mode = case row[:colorize_type]
		       when 'shift' then 1
		       when 'tint' then 2
		       else 0
		       end
		active = row[:material_type] == 2 && [1, 2].include?(mode)
		material = {
			materialIndex: index,
			name: row[:name],
			displayName: row[:display_name],
			rgba: [row.dig(:color, :r), row.dig(:color, :g), row.dig(:color, :b), row.dig(:color, :a)],
			opacity: row[:opacity],
			textureIndex: row[:texture],
			textureWidthM: row[:texture_width_m],
			textureHeightM: row[:texture_height_m],
			activeSemantic: active
		}
		if active
			material[:semantic] = {
				materialType: row[:material_type], colorizeMode: mode,
				deltas: [row.dig(:colorize_deltas, :h), row.dig(:colorize_deltas, :l), row.dig(:colorize_deltas, :s)],
				outputRgbaSha256: row[:colorize_output_sha256]
			}
		end
		material
	end
	active_count = materials.count { |material| material[:activeSemantic] }
	unless active_count == fixture.dig('expected', 'activeSemanticCount')
		raise "Ruby active semantic count differs for #{fixture.fetch('id')}"
	end
	{
		id: fixture.fetch('id'), bytes: bytes.bytesize, sha256: actual_hash,
		materialVersion: fixture.dig('expected', 'materialVersion'),
		sourceTextureCount: fixture.dig('expected', 'sourceTextureCount'),
		activeSemanticCount: active_count, materials: materials
	}
end

rgb_cases = [
	[0, 0, 0], [255, 255, 255], [115, 137, 98], [255, 0, 0], [0, 255, 0], [0, 0, 255],
	[127, 127, 127], [128, 128, 128], [129, 129, 129], [127, 128, 129], [128, 128, 129],
	[1, 0, 0], [0, 1, 0], [0, 0, 1], [255, 254, 253], [1, 254, 128]
]
delta_cases = [
	[0, 0, 0], [92.58741048890613, 0.13725490868091583, -0.11229892646129502],
	[-360, -1, -1], [360, 1, 1], [-0.001, 0.000999, 0.000999], [0.001, 0.001, 0.001],
	[60, -0.49, 0.5], [180, -0.5, -0.5], [240, 0.5, 0], [359.999, 0, 1], [-359.999, 0, -1]
]
alpha_values = [0, 1, 127, 255]
vectors = []
[1, 2].each do |mode|
	delta_cases.each do |deltas|
		pixels = []
		rgb_cases.each do |rgb|
			alpha_values.each do |alpha|
				output_rgb = BOMEngine::BOMCSketchupColorize.colorize_pixel(*rgb, *deltas, mode == 1)
				pixels << { input: [*rgb, alpha], output: [*output_rgb, alpha] }
			end
		end
		vectors << { mode: mode, deltas: deltas, pixels: pixels }
	end
end

png_pixels = [
	[17, 93, 201, 0], [231, 12, 47, 1], [2, 241, 81, 127], [113, 137, 99, 255]
]
png_mode = 1
png_deltas = [92.58741048890613, 0.13725490868091583, -0.11229892646129502]
png_expected = png_pixels.map do |rgba|
	output_rgb = BOMEngine::BOMCSketchupColorize.colorize_pixel(*rgba.first(3), *png_deltas, true)
	[*output_rgb, rgba[3]]
end

producer_files = %w[bom_engine/bomc_decoder.rb bom_engine/bomc_sketchup_colorize.rb]
producer_hashes = {}
producer_files.each { |relative| producer_hashes[relative] = sha256(File.join(producer_root, relative)) }
git_commit = IO.popen(['git', '-C', producer_root, 'rev-parse', 'HEAD'], &:readline).strip
metadata = {
	schemaVersion: 'bomc-materials-v2-ruby-oracle-v1',
	producer: { commit: git_commit, root: 'bom_engine_plugin', sourceSha256: producer_hashes },
	fixtureManifestSha256: sha256(manifest_path),
	fixtures: fixture_metadata,
	activeSemanticMaterialCount: fixture_metadata.sum { |fixture| fixture.fetch(:activeSemanticCount) }
}
raise 'Expected exactly 54 active semantic materials' unless metadata.fetch(:activeSemanticMaterialCount) == 54

vector_fixture = {
	schemaVersion: 'bomc-semantic-colorize-ruby-v1',
	producer: {
		commit: git_commit,
		colorizeSourceSha256: producer_hashes.fetch('bom_engine/bomc_sketchup_colorize.rb')
	},
	caseCount: vectors.sum { |vector| vector.fetch(:pixels).length },
	vectors: vectors,
	pngCase: { width: 2, height: 2, sourceRgba: png_pixels, mode: png_mode, deltas: png_deltas, expectedRgba: png_expected,
		expectedRgbaSha256: Digest::SHA256.hexdigest(png_expected.flatten.pack('C*')) }
}
raise 'Expected exactly 1,408 independent RGBA vectors' unless vector_fixture.fetch(:caseCount) == 1_408

FileUtils.mkdir_p(output_dir)
write_json(metadata_path, metadata)
FileUtils.mkdir_p(File.dirname(vectors_output))
write_json(vectors_output, vector_fixture, immutable: true)
puts JSON.pretty_generate({ metadata: metadata_path, vectors: vectors_output, fixtures: fixture_metadata.map { |item| [item.fetch(:id), item.fetch(:sha256)] }, activeSemanticMaterialCount: metadata.fetch(:activeSemanticMaterialCount), vectorCount: vector_fixture.fetch(:caseCount) })
