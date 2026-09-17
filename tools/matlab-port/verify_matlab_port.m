function report = verify_matlab_port(outputDirectory)
%VERIFY_MATLAB_PORT Execute independent oracles and source parity in MATLAB.
% A failed check is saved to validation.json and then raises an error. Optional
% product checks explicitly report SKIPPED; they never become implicit passes.
root = fileparts(mfilename('fullpath'));
if nargin < 1 || isempty(outputDirectory), outputDirectory = fullfile(root,'output'); end
if ~isfolder(outputDirectory), mkdir(outputDirectory); end
[cfg, ref] = docking.loadReference();
report = struct('status','RUNNING','matlabVersion',version,'platform',computer, ...
    'sourceFiles',{ref.sourceFiles},'sourceHashes',ref.sourceHashes,'checks',{{}});
check('current_source_hashes',@checkSources);
if strcmp(report.checks{end}.status,'FAILED'), finish(); return; end
check('independent_dynamics_oracles',@dynamicsOracles);
check('actuator_physics_and_boundaries',@actuatorOracles);
check('input_validation',@inputValidation);
check('nominal_typescript_parity',@() pulseParity(ref.cases.nominal));
check('fault_typescript_parity',@() pulseParity(ref.cases.stuckOpen));
if exist('dlqr','file') && license('test','Control_Toolbox')
    check('independent_lqr_solution',@lqrOracle);
else
    skip('independent_lqr_solution','Control System Toolbox unavailable');
end
if ~isempty(which('sim')) && license('test','Simulink')
    check('simulink_execution',@simulinkParity);
else
    skip('simulink_execution','Simulink unavailable');
end
finish();

    function check(name,fn)
        entry = struct('name',name,'status','PASSED','metrics',struct(),'message','');
        try
            entry.metrics = fn();
        catch exception
            entry.status = 'FAILED'; entry.message = exception.message;
            fprintf(2,'FAIL %s: %s\n',name,exception.message);
        end
        report.checks{end+1} = entry;
        if strcmp(entry.status,'PASSED'), fprintf('PASS %s\n',name); end
    end
    function skip(name,message)
        report.checks{end+1} = struct('name',name,'status','SKIPPED', ...
            'metrics',struct(),'message',message);
        fprintf('SKIP %s: %s\n',name,message);
    end
    function finish()
        statuses = cellfun(@(c)c.status,report.checks,'UniformOutput',false);
        if any(strcmp(statuses,'FAILED')), report.status = 'FAILED';
        elseif any(strcmp(statuses,'SKIPPED')), report.status = 'PARTIAL';
        else, report.status = 'PASSED'; end
        file = fopen(fullfile(outputDirectory,'validation.json'),'w');
        assert(file >= 0,'Could not write validation report');
        guard = onCleanup(@()fclose(file)); %#ok<NASGU>
        fprintf(file,'%s\n',jsonencode(report,PrettyPrint=true));
        fprintf('MATLAB port validation: %s\n',report.status);
        if strcmp(report.status,'FAILED')
            error('docking:VerificationFailed','One or more MATLAB checks failed; see validation.json.');
        end
    end
    function metrics = checkSources()
        node = getenv('DOCKING_NODE');
        if isempty(node)
            [status,~] = system('node --version');
            if status == 0, node='node';
            elseif isfile('/opt/homebrew/bin/node'), node='/opt/homebrew/bin/node';
            elseif isfile('/usr/local/bin/node'), node='/usr/local/bin/node';
            else, error('Node is needed to verify current TypeScript source hashes. Set DOCKING_NODE.'); end
        end
        % Paths are local trusted tool paths; reject shell expansion characters.
        assert(~contains(node,{'"','$','`',newline}) && ~contains(root,{'"','$','`',newline}), ...
            'Unsupported shell characters in validation tool paths');
        [status,message] = system(sprintf('"%s" "%s" --check',node,fullfile(root,'exportReference.mjs')));
        assert(status == 0,'Source freshness failed: %s',message);
        metrics = struct('message',strtrim(message));
    end
    function metrics = dynamicsOracles()
        step = @(t,x,a,tau,mdot,dt,n,I) docking.stepTruth(x,dt,t, ...
            struct('meanMotionRadS',n,'inertia_kg_m2',I, ...
            'externalSpecificForce_body_mps2',a,'torque_body_Nm',tau,'propellantRate_kg_s',mdot));
        metrics = verify_dynamics_oracles(step,cfg.meanMotionRadS,cfg.inertia_kg_m2(:));
        [phi,gamma]=docking.cwDiscreteMatrices(cfg.meanMotionRadS,ref.lqr.dt_s);
        metrics.nativeCwPhiError=max(abs(phi-ref.lqr.phi),[],'all');
        metrics.nativeCwGammaError=max(abs(gamma-ref.lqr.gamma),[],'all');
        assert(metrics.nativeCwPhiError<1e-8 && metrics.nativeCwGammaError<1e-10, ...
            'Native CW matrices differ from the reference');
        dt=0.3; [phi,gamma]=docking.cwDiscreteMatrices(0,dt);
        assert(norm(phi-[eye(3),dt*eye(3);zeros(3),eye(3)],'fro')<1e-14 && ...
            norm(gamma-[0.5*dt^2*eye(3);dt*eye(3)],'fro')<1e-14, ...
            'Zero-mean-motion limit must be a constant-acceleration double integrator');
    end
    function metrics = pulseParity(definition)
        actual = docking.runPulseCase(definition,cfg);
        expected = [definition.truthSamples.state];
        if size(expected,1) ~= 14, expected = reshape(expected,14,[]); end
        metrics = stateErrors(actual.states,expected);
        assert(numel(actual.time_s) == definition.ticks+1,'Wrong sample count');
        metrics.timeError_s = max(abs(actual.time_s-[definition.truthSamples.time_s]));
        assert(metrics.timeError_s < 1e-9,'Wrong integration epoch or sample timing');
        assertStateErrors(metrics);
    end
    function metrics = actuatorOracles()
        count = numel(cfg.specs); W = zeros(6,count);
        forceError = 0; torqueError = 0;
        options = cfg; options.window_s = 0.1; options.prop_kg = 24;
        for j=1:count
            command = zeros(count,1); command(j) = 0.03;
            a = docking.applyThrusters(command,options);
            spec=cfg.specs(j); r=spec.position_body_m(:);
            F=spec.direction_body(:)*spec.thrust_N;
            tau=[r(2)*F(3)-r(3)*F(2);r(3)*F(1)-r(1)*F(3);r(1)*F(2)-r(2)*F(1)];
            W(:,j)=[F;tau];
            forceError=max(forceError,norm(a.force_N-0.3*F));
            torqueError=max(torqueError,norm(a.torque_Nm-0.3*tau));
            expectedFuel=spec.thrust_N*0.03/(cfg.isp_s*cfg.g0_mps2);
            assert(abs(a.propellantUsed_kg-expectedFuel)<1e-14,'Single-jet fuel impulse incorrect');
        end
        assert(forceError<1e-10 && torqueError<1e-10,'Single-jet force/torque oracle failed');
        assert(rank(W)==6,'Geometry does not span six wrench components');
        thresholds=[0.019,0.020,0.0249,0.02501,0.2]; expected=[0,0.02,0.02,0.03,0.1];
        for k=1:numel(thresholds)
            command=zeros(count,1); command(1)=thresholds(k);
            a=docking.applyThrusters(command,options);
            assert(abs(a.activeOnTime_s(1)-expected(k))<1e-14,'Pulse boundary/rounding failed');
        end
        slice=options; slice.window_s=0.01; slice.minOnTime_s=0;
        command=zeros(count,1); command(1)=0.01;
        a=docking.applyThrusters(command,slice);
        assert(a.activeOnTime_s(1)==0.01,'Valid 10 ms slice was lost');
        id=cfg.specs(1).id;
        for state={'isolated','stuck_closed'}
            fault=options; fault.states=struct(); fault.states.(id)=state{1};
            command=zeros(count,1); command(1)=0.1;
            a=docking.applyThrusters(command,fault);
            assert(norm(a.force_N)==0 && a.propellantUsed_kg==0,'Disabled jet fired');
        end
        fault=options; fault.states=struct(); fault.states.(id)='stuck_open';
        a=docking.applyThrusters(zeros(count,1),fault);
        assert(a.activeOnTime_s(1)==0.1,'Stuck-open jet obeyed zero command');
        fuel=options; command=zeros(count,1); command(1:2)=0.1;
        requested=sum([cfg.specs(1:2).thrust_N])*0.1/(cfg.isp_s*cfg.g0_mps2);
        fuel.prop_kg=requested/2;
        a=docking.applyThrusters(command,fuel);
        assert(max(abs(a.activeOnTime_s(1:2)-0.05))<1e-13,'Starvation did not scale jets equally');
        assert(abs(a.propellantUsed_kg-fuel.prop_kg)<1e-14,'Fuel availability not respected');
        fuel.prop_kg=0; a=docking.applyThrusters(command,fuel);
        assert(norm(a.force_N)==0 && norm(a.torque_Nm)==0 && a.exhausted,'Dry vehicle produced thrust');
        metrics=struct('singleJetForceError_N',forceError,'singleJetTorqueError_Nm',torqueError, ...
            'wrenchMatrixRank',rank(W),'jetsChecked',count,'thresholdsChecked',numel(thresholds));
    end
    function metrics = inputValidation()
        x=cfg.initial.state(:);
        requireError(@()docking.stepTruth(x,0,0,struct()));
        requireError(@()docking.stepTruth(x,0.01,0,struct('inertia_kg_m2',[0;1;1])));
        requireError(@()docking.stepTruth(x,0.01,0,struct('torque_body_Nm',[NaN;0;0])));
        bad=x; bad(7:10)=0; requireError(@()docking.stepTruth(bad,0.01,0,struct()));
        requireError(@()docking.applyThrusters(NaN(numel(cfg.specs),1),cfg));
        badCfg=cfg; badCfg.specs(1).thrust_N=NaN;
        requireError(@()docking.applyThrusters(zeros(numel(cfg.specs),1),badCfg));
        metrics=struct('invalidInputsRejected',6);
    end
    function metrics = lqrOracle()
        n=cfg.meanMotionRadS; dt=ref.lqr.dt_s;
        A=zeros(6); A(1:3,4:6)=eye(3); A(4,1)=3*n*n;
        A(4,5)=2*n; A(5,4)=-2*n; A(6,3)=-n*n;
        B=[zeros(3);eye(3)]; Z=expm([A,B;zeros(3,9)]*dt);
        phi=Z(1:6,1:6); gamma=Z(1:6,7:9);
        Q=diag(ref.lqr.qWeights); R=diag(ref.lqr.rWeights);
        [K,P,poles]=dlqr(phi,gamma,Q,R);
        residual=norm(Q+phi'*P*phi-phi'*P*gamma*K-P,'fro');
        metrics=struct('gainMaxError',max(abs(K-ref.lqr.gain_3x6),[],'all'), ...
            'phiMaxError',max(abs(phi-ref.lqr.phi),[],'all'), ...
            'gammaMaxError',max(abs(gamma-ref.lqr.gamma),[],'all'), ...
            'dareResidual',residual,'largestPoleMagnitude',max(abs(poles)));
        assert(metrics.gainMaxError<1e-7,'LQR gain mismatch');
        assert(metrics.phiMaxError<1e-8 && metrics.gammaMaxError<1e-10,'CW ZOH matrix mismatch');
        assert(residual<1e-7 && metrics.largestPoleMagnitude<1,'LQR stability/residual failed');
        x=[0.05;-0.10;0.03;0;0;0];
        for k=1:600, x=(phi-gamma*K)*x; end
        metrics.finalStateNorm=norm(x);
        assert(metrics.finalStateNorm<1e-7,'Ideal linear regulation did not settle');
    end
    function metrics = simulinkParity()
        original=Simulink.fileGenControl('getConfig');
        restore=onCleanup(@()Simulink.fileGenControl('setConfig','config',original)); %#ok<NASGU>
        Simulink.fileGenControl('set','CacheFolder',fullfile(outputDirectory,'cache'), ...
            'CodeGenFolder',fullfile(outputDirectory,'codegen'),'createDir',true);
        metrics=struct();
        for key={'nominal','stuckOpen'}
            definition=ref.cases.(key{1});
            native=docking.runPulseCase(definition,cfg);
            modelPath=build_spacecraft_model(outputDirectory,cfg,definition);
            load_system(modelPath);
            closeModel=onCleanup(@()close_system('dragon_sixdof',0));
            output=sim('dragon_sixdof');
            ts=output.truthLog;
            actual=reshape(ts.Data,[],14)';
            item=stateErrors(actual,native.states);
            assertStateErrors(item);
            item.timeError_s=max(abs(ts.Time(:)'-native.time_s+definition.startTime_s));
            item.sampleCount=numel(ts.Time);
            assert(item.timeError_s<1e-9 && item.sampleCount==definition.ticks+1, ...
                'Simulink timing/sample count mismatch');
            restarted=sim('dragon_sixdof');
            assert(isequal(restarted.truthLog.Data,ts.Data),'Simulink fresh-run reset was not deterministic');
            item.resetRepeatExact=true;
            metrics.(key{1})=item;
            clear closeModel;
        end
        % Leave the saved model on the nominal case for the user's first Run.
        build_spacecraft_model(outputDirectory,cfg,ref.cases.nominal);
    end
end

function metrics = stateErrors(actual,expected)
assert(isequal(size(actual),size(expected)),'Trajectory dimensions differ');
assert(all(isfinite(actual),'all'),'Nonfinite trajectory');
qMinus=sqrt(sum((actual(7:10,:)-expected(7:10,:)).^2,1));
qPlus=sqrt(sum((actual(7:10,:)+expected(7:10,:)).^2,1));
metrics=struct('positionError_m',max(abs(actual(1:3,:)-expected(1:3,:)),[],'all'), ...
    'velocityError_mps',max(abs(actual(4:6,:)-expected(4:6,:)),[],'all'), ...
    'quaternionError',max(min(qMinus,qPlus)), ...
    'angularRateError_rps',max(abs(actual(11:13,:)-expected(11:13,:)),[],'all'), ...
    'propellantError_kg',max(abs(actual(14,:)-expected(14,:)),[],'all'));
end
function assertStateErrors(m)
assert(m.positionError_m<1e-7 && m.velocityError_mps<1e-8,'Position/velocity parity failed');
assert(m.quaternionError<1e-10 && m.angularRateError_rps<1e-9,'Attitude/rate parity failed');
assert(m.propellantError_kg<1e-9,'Propellant parity failed');
end
function requireError(fn)
rejected=false;
try, fn(); catch, rejected=true; end
assert(rejected,'Invalid input was silently accepted');
end
