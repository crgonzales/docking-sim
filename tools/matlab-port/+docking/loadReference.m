function [config, fixtures] = loadReference(referencePath)
%LOADREFERENCE Load the checked-in MATLAB-port configuration and fixtures.
% One output returns the complete fixture document. Two outputs return the
% normalized config and the complete fixture document, respectively.

if nargin < 1 || isempty(referencePath)
    packageDirectory = fileparts(mfilename('fullpath'));
    referencePath = fullfile(fileparts(packageDirectory), 'fixtures', 'reference.json');
end
if ~(ischar(referencePath) || isstring(referencePath))
    error('docking:InvalidPath', 'referencePath must be text.');
end
referencePath = char(referencePath);
if ~isfile(referencePath)
    error('docking:MissingFixture', 'Reference fixture does not exist: %s', referencePath);
end

raw = fileread(referencePath);
fixtures = jsondecode(raw);
if ~isstruct(fixtures) || ~isfield(fixtures, 'schemaVersion') || fixtures.schemaVersion ~= 1
    error('docking:InvalidFixture', 'Unsupported or malformed MATLAB-port fixture.');
end
if ~isfield(fixtures, 'config') || ~isfield(fixtures.config, 'specs')
    error('docking:InvalidFixture', 'Fixture has no spacecraft config or thruster geometry.');
end

config = fixtures.config;
config.referencePath = referencePath;
config.initial.state = config.initial.state(:);
config.inertia_kg_m2 = config.inertia_kg_m2(:);
if isfield(config, 'specs')
    for index = 1:numel(config.specs)
        config.specs(index).position_body_m = config.specs(index).position_body_m(:);
        config.specs(index).direction_body = config.specs(index).direction_body(:);
        if numel(config.specs(index).position_body_m) ~= 3 || any(~isfinite(config.specs(index).position_body_m))
            error('docking:InvalidFixture', 'Thruster positions must be finite 3x1 vectors.');
        end
        if numel(config.specs(index).direction_body) ~= 3 || any(~isfinite(config.specs(index).direction_body)) || norm(config.specs(index).direction_body) == 0
            error('docking:InvalidFixture', 'Thruster directions must be finite and non-zero 3x1 vectors.');
        end
        if ~isfinite(config.specs(index).thrust_N) || config.specs(index).thrust_N <= 0
            error('docking:InvalidFixture', 'Thruster thrust must be finite and positive.');
        end
    end
end
if numel(config.initial.state) ~= 14 || any(~isfinite(config.initial.state)) || norm(config.initial.state(7:10)) == 0
    error('docking:InvalidFixture', 'Initial state must be finite 14x1 with a non-zero quaternion.');
end
if ~isfinite(config.dt_s) || config.dt_s <= 0 || ~isfinite(config.dryMass_kg) || config.dryMass_kg <= 0 || ...
        any(~isfinite(config.inertia_kg_m2)) || any(config.inertia_kg_m2 <= 0)
    error('docking:InvalidFixture', 'Fixture timing, mass, and inertia values are invalid.');
end
if nargout <= 1
    config = fixtures;
end
end
