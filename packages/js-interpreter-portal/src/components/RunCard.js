import moment from 'moment-mini';
import React, { Component } from 'react';
import PropTypes from 'prop-types';
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
import { withTheme } from 'material-ui/styles';
import { grey } from 'material-ui/colors';

import MainCard from './MainCard';
import Connection from '../client/Connection';
import TyrantEventQueue, { Events } from '../client/TyrantEventQueue';
import LogOutput from './LogOutput';
import TestResultsTable from './TestResultsTable';

class GlobInput extends Component {
  state = {
    value: 'built-ins/Object/defineProperty/*.js',
  };

  static propsTypes = {
    onClickRun: PropTypes.func.isRequired,
    onClickKill: PropTypes.func.isRequired,
    slaveState: PropTypes.object.isRequired,
    canRun: PropTypes.bool.isRequired,
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
              onChange={e => this.setState({ value: e.target.value })}
              margin="normal"
              fullWidth
            />
          </form>
        </CardContent>
        <CardActions>
          <Button
            color="primary"
            raised
            disabled={this.props.slaveState.running > 0 || !this.props.canRun}
            onClick={() =>
              this.props.onClickRun(
                this.state.value
                  .split(' ')
                  .filter(s => !!s)
                  .map(fn => `tyrant/test262/test/${fn}`)
              )
            }
          >
            {this.state.value ? 'Run Tests' : 'Run All 40,0000+ Tests'}
          </Button>
          <Button
            raised
            disabled={this.props.slaveState.running === 0}
            onClick={this.props.onClickKill}
          >
            Stop
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
    canRun: false,
  };

  run = tests => {
    Object.keys(this.state.slaves).forEach(slaveId =>
      this.setSlaveState(slaveId, { results: [] })
    );
    Connection.MasterRunner.execute({ tests });
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

  onTyrantEvents = events => {
    const newResults = {};
    events.forEach(event => {
      const { slaveId, eventName, data } = event;
      if (eventName === Events.TICK) {
        const { test } = data;
        newResults[slaveId] = newResults[slaveId] || [];
        newResults[slaveId].push(test);
      } else if (eventName === Events.RERUNNING_TESTS) {
        const { files, retriesLeft } = data;
        const slaveState = this.getSlaveState(slaveId);
        const filesToRemove = new Set(
          files.map(file => file.split('test262')[1])
        );
        const results = (slaveState.results || []).filter(
          oldTest => !filesToRemove.has(oldTest.file.split('test262')[1])
        );
        this.setSlaveState(slaveId, {
          retriesLeft,
          results,
        });
      }
    });
    Object.keys(newResults).forEach(slaveId => {
      const slaveState = this.getSlaveState(slaveId);
      this.setSlaveState(slaveId, {
        results: [...(slaveState.results || []), ...newResults[slaveId]],
      });
    });
  };

  async componentDidMount() {
    TyrantEventQueue.on('multi', this.onTyrantEvents);
    Connection.MasterRunner.onClientStateChange(newState => {
      this.setState(newState);
    });
    Connection.SlaveRunner.onClientStateChange(newState =>
      this.setSlaveState(newState.slaveId, newState)
    );
    const state = await Connection.SlaveManager.getClientState();
    this.setState({ canRun: state.slaves.length > 0 });
    Connection.SlaveManager.onClientStateChange(state =>
      this.setState({ canRun: state.slaves.length > 0 })
    );

    const slaveStates = await Connection.MasterRunner.getSlaveStates();
    slaveStates.forEach(({ result: state, slaveId }) => {
      this.setSlaveState(slaveId, state);
    });
  }

  onClickLoadSavedResults = async () => {
    const savedResults = await Connection.MasterRunner.getSavedResults();
    this.setState({ savedResults });
  };

  onClickLoadNewResults = async () => {
    const newResults = await Connection.MasterRunner.getNewResults();
    newResults.forEach(({ result: results, slaveId }) => {
      this.setSlaveState(slaveId, { results });
    });
  };

  onClickSaveResults = async () => {
    await Connection.MasterRunner.saveResults();
  };

  onClickRerunTests = async tests => {
    Connection.MasterRunner.execute({ tests, rerun: true });
  };
  onClickRun = tests => this.run(tests);
  onClickKill = async () => {
    await Connection.MasterRunner.kill();
  };

  handleChange = name => ({ target: { value } }) =>
    this.setState({ [name]: value });

  getAggregateSlaveState() {
    const state = {
      numTests: 1,
      completed: 0,
      results: [],
      running: 0,
      minutes: 0,
    };
    Object.values(this.state.slaves).forEach(slave => {
      state.numTests += slave.numTests || 1;
      state.completed += slave.completed || 0;
      state.minutes = Math.max(state.minutes, slave.minutes || 0);
      if (slave.results) {
        state.results = state.results.concat(slave.results);
      }
      if (slave.running) {
        state.running += 1;
      }
    });
    return state;
  }

  changeTab = (event, tab) => this.setState({ tab });

  render() {
    const state = this.getAggregateSlaveState();
    const progress =
      state.numTests > 0 ? state.completed / state.numTests * 100 : null;
    const hasResults = state.results && state.results.length > 0;
    const hasChangedResults = state.results.reduce(
      (found, test) => found || test.isFix || test.isRegression || test.isNew,
      false
    );
    const numRegressions = state.results.reduce(
      (num, test) => num + (test.isRegression ? 1 : 0),
      0
    );
    const timeRemaining = moment.duration({ minutes: state.minutes });
    return (
      <MainCard>
        <CardHeader title="Test Results" />
        <CardContent>
          <GlobInput
            slaveState={state}
            onClickRun={this.onClickRun}
            onClickKill={this.onClickKill}
            canRun={this.state.canRun}
          />
        </CardContent>
        <CardContent>
          <Card>
            <Tabs value={this.state.tab} onChange={this.changeTab}>
              <Tab value="new-results" label="New Results" />
              <Tab value="saved-results" label="Saved Results" />
            </Tabs>
            {this.state.tab === 'saved-results' && (
              <div>
                {this.state.savedResults ? (
                  <TestResultsTable
                    results={this.state.savedResults}
                    onClickRun={this.onClickRerunTests}
                  />
                ) : (
                  <CardContent style={{ textAlign: 'center' }}>
                    <Button
                      raised
                      color="primary"
                      onClick={this.onClickLoadSavedResults}
                    >
                      Load Saved Results
                    </Button>
                    <Typography type="caption" style={{ marginTop: 8 }}>
                      This operation can take a second
                    </Typography>
                  </CardContent>
                )}
              </div>
            )}
            {this.state.tab === 'new-results' && (
              <div>
                <CardContent>
                  {state.results.length === 0 &&
                    !state.running > 0 && (
                      <div style={{ textAlign: 'center' }}>
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
                      </div>
                    )}
                  {state.running > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <div style={{ flexBasis: '100%' }}>
                        <LinearProgress
                          color="accent"
                          mode="determinate"
                          value={progress}
                        />
                      </div>
                      <div style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>
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
                          {timeRemaining.humanize()} left
                        </Typography>
                        <Typography color="accent" type="caption">
                          {state.running} slave{state.running !== 1 && 's'}{' '}
                          running
                        </Typography>
                      </div>
                    </div>
                  )}
                </CardContent>
                {state.results.length > 0 && (
                  <TestResultsTable
                    results={state.results}
                    onClickRun={this.onClickRerunTests}
                  />
                )}
                <CardActions>
                  <Button
                    color="primary"
                    raised
                    disabled={numRegressions === 0 || state.running > 0}
                    onClick={this.onClickRerunTests}
                  >
                    Rerun {numRegressions} Tests
                  </Button>

                  <Button
                    disabled={
                      state.results.length === 0 ||
                      state.running > 0 ||
                      !hasChangedResults
                    }
                    color="primary"
                    raised
                    onClick={this.onClickSaveResults}
                    style={{ marginLeft: 8 }}
                  >
                    {hasChangedResults
                      ? 'Save Results'
                      : 'No New Results To Save'}
                  </Button>
                  <Button
                    href="/test-results-new.json"
                    style={{ marginLeft: 8 }}
                  >
                    Download Results
                  </Button>
                </CardActions>
              </div>
            )}
          </Card>
        </CardContent>
      </MainCard>
    );
  }
}
