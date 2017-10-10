import React, {Component} from 'react';
import {
  LinearProgress,
  Button,
  Tabs,
  Tab,
  CardHeader,
  CardContent,
  CardActions,
  Card,
  TextField,
  Typography,
  Paper,
} from 'material-ui';
import {withTheme} from 'material-ui/styles';
import {grey} from 'material-ui/colors';

import MainCard from './MainCard';
import Connection from '../client/Connection';
import TyrantEventQueue, {Events} from '../client/TyrantEventQueue';
import LogOutput from './LogOutput';
import TestResultsTable from './TestResultsTable';

class GlobInput extends Component {
  state = {
    value: 'language/types/string/**.js',
  };

  render() {
    return (
      <Card>
        <CardContent>
          <form noValidate autoComplete="off">
            <TextField
              id="paths"
              label="Test File Glob"
              helperText="Use this to limit the number of files being tested. (i.e. language/types/string/**.js)"
              value={this.state.value}
              onChange={e => this.setState({value: e.target.value})}
              margin="normal"
              fullWidth
            />
          </form>
        </CardContent>
        <CardActions>
          <Button
            color="primary"
            raised
            onClick={() =>
              this.props.onClickRun(
                this.state.value
                  .split(' ')
                  .map(fn => `tyrant/test262/test/${fn}`)
              )}
          >
            {this.state.value ? 'Run Tests' : 'Run All 40,0000+ Tests'}
          </Button>
        </CardActions>
      </Card>
    );
  }
}

@withTheme
export default class RunCard extends Component {
  static propTypes = {};

  state = {
    slaves: {},
    savedResults: null,
    tab: 'new-results',
    testGlob: '',
    isRunning: false,
  };

  run = tests => {
    this.setState({numTests: tests ? tests.length * 2 : 1, completed: 0});
    Connection.MasterRunner.execute({tests});
  };

  getSlaveState(slaveId) {
    return this.state.slaves[slaveId] || {};
  }

  setSlaveState(slaveId, newState) {
    this.setState({
      slaves: {
        ...this.state.slaves,
        [slaveId]: {
          ...this.getSlaveState(slaveId),
          ...newState,
        },
      },
    });
  }

  onTick = ({slaveId, data: {test, minutes}}) => {
    const slaveState = this.getSlaveState(slaveId);
    this.setSlaveState(slaveId, {
      completed: slaveState.completed + 1,
      minutes,
      results: [...slaveState.results, test],
    });
  };

  onStartedExecution = ({slaveId}) => {
    this.setSlaveState(slaveId, {running: true});
  };

  onStartedRunning = ({slaveId, data: {numTests}}) => {
    this.setSlaveState(slaveId, {
      numTests,
      completed: 0,
      results: [],
    });
  };

  onFinishedExecution = ({slaveId}) => {
    this.setSlaveState(slaveId, {running: false});
  };

  componentDidMount() {
    TyrantEventQueue.on(Events.TICK, this.onTick);
    TyrantEventQueue.on(Events.STARTED_EXECUTION, this.onStartedExecution);
    TyrantEventQueue.on(Events.STARTED_RUNNING, this.onStartedRunning);
    TyrantEventQueue.on(Events.FINISHED_EXECUTION, this.onFinishedExecution);
    Connection.MasterRunner.onClientStateChange(newState => {
      this.setState(newState);
    });
  }

  onClickLoadSavedResults = async () => {
    const savedResults = await Connection.MasterRunner.getSavedResults();
    this.setState({savedResults});
  };

  onClickLoadNewResults = async () => {
    const newResults = await Connection.MasterRunner.getNewResults();
    newResults.forEach(({result: results, slaveId}) =>
      this.setSlaveState(slaveId, {results})
    );
  };

  onClickSaveResults = async () => {
    await Connection.MasterRunner.saveResults(
      this.getAggregateSlaveState().results
    );
  };

  onClickRerunTests = async tests => {
    this.run(tests);
  };
  onClickRun = () => this.run(this.state.testGlob.split(' '));

  handleChange = name => ({target: {value}}) => this.setState({[name]: value});

  getAggregateSlaveState() {
    const state = {
      numTests: 1,
      completed: 0,
      results: [],
      running: false,
      minutes: 0,
    };
    Object.values(this.state.slaves).forEach(slave => {
      state.numTests += slave.numTests;
      state.completed += slave.completed;
      state.minutes = Math.max(state.minutes, slave.minutes || 0);
      if (slave.results) {
        state.results = state.results.concat(slave.results);
      }
      if (slave.running) {
        state.running = true;
      }
    });
    return state;
  }

  changeTab = (event, tab) => this.setState({tab});

  render() {
    const state = this.getAggregateSlaveState();
    const progress =
      state.numTests > 0 ? state.completed / state.numTests * 100 : null;
    const hasResults = state.results && state.results.length > 0;
    const hasChangedResults = state.results.reduce(
      (found, test) => found || test.isFix || test.isRegression || test.isNew,
      false
    );
    const minutes = Math.floor(state.minutes);
    const seconds = Math.floor((state.minutes - minutes) * 60);
    return (
      <MainCard>
        <CardHeader title="Test Results" />
        <CardContent>
          <GlobInput onClickRun={this.onClickRerunTests} />
        </CardContent>
        <CardContent>
          <Card>
            <Tabs value={this.state.tab} onChange={this.changeTab}>
              <Tab value="new-results" label="New Results" />
              <Tab value="saved-results" label="Saved Results" />
            </Tabs>
            {this.state.tab === 'saved-results' &&
              <div>
                {this.state.savedResults
                  ? <TestResultsTable
                      results={this.state.savedResults}
                      onClickRun={this.onClickRerunTests}
                    />
                  : <CardContent style={{textAlign: 'center'}}>
                      <Button
                        raised
                        color="primary"
                        onClick={this.onClickLoadSavedResults}
                      >
                        Load Saved Results
                      </Button>
                      <Typography type="caption" style={{marginTop: 8}}>
                        This operation can take a second
                      </Typography>
                    </CardContent>}
              </div>}
            {this.state.tab === 'new-results' &&
              <div>
                <CardContent>
                  {state.results.length === 0 &&
                    !state.running &&
                    <div style={{textAlign: 'center'}}>
                      <Typography type="body1">
                        Run tests to see new results or...
                      </Typography>
                      <Button
                        raised
                        color="primary"
                        onClick={this.onClickLoadNewResults}
                      >
                        Load New Results
                      </Button>
                    </div>}
                  {state.running &&
                    <div style={{display: 'flex', alignItems: 'center'}}>
                      <div style={{flexBasis: '100%'}}>
                        <LinearProgress
                          color="accent"
                          mode="determinate"
                          value={progress}
                        />
                      </div>
                      <div style={{marginLeft: 8, whiteSpace: 'nowrap'}}>
                        <span
                          style={{
                            color: this.props.theme.palette.secondary[700],
                          }}
                        >
                          {state.completed}
                        </span>
                        <span
                          style={{
                            color: this.props.theme.palette.secondary[400],
                          }}
                        >
                          /{state.numTests}
                        </span>
                        <Typography color="accent" type="caption">
                          {minutes
                            ? `${minutes}m`
                            : seconds ? `${seconds}s` : '? mins'}{' '}
                          left
                        </Typography>
                      </div>
                    </div>}
                </CardContent>
                {state.results.length > 0 &&
                  <TestResultsTable
                    results={state.results}
                    onClickRun={this.onClickRerunTests}
                  />}
                <CardActions>
                  <Button
                    disabled={
                      state.results.length === 0 ||
                      state.running ||
                      !hasChangedResults
                    }
                    color="primary"
                    raised
                    onClick={this.onClickSaveResults}
                    style={{marginLeft: 8}}
                  >
                    {hasChangedResults
                      ? 'Save Results'
                      : 'No New Results To Save'}
                  </Button>
                </CardActions>
              </div>}
          </Card>
        </CardContent>
      </MainCard>
    );
  }
}
